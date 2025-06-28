const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require("axios");
const crypto = require("crypto");
const WebSocket = require("ws");
const rateLimit = require('express-rate-limit');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

// 检查并导入mp3-parser，如果不存在则提供fallback
let mp3Parser;
try {
  mp3Parser = require("mp3-parser");
} catch (error) {
  console.warn('mp3-parser not found, using fallback implementation');
  mp3Parser = {
    readFrameHeader: () => ({ bitrate: 128000 }) // 默认128kbps
  };
}

// ========== 日志系统 ==========
class Logger {
  constructor() {
    this.logDir = path.join(__dirname, 'logs');
    this.ensureLogDirectory();
  }
  
  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
  
  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      data,
      pid: process.pid,
      memory: process.memoryUsage(),
      worker: cluster.isWorker ? cluster.worker.id : 'master'
    };
    
    console.log(`[${timestamp}] [${level.toUpperCase()}] [PID:${process.pid}] ${message}`, data || '');
    
    // 写入日志文件
    this.writeToFile(level, logEntry);
  }
  
  writeToFile(level, logEntry) {
    try {
      const logFile = path.join(this.logDir, `${level.toLowerCase()}.log`);
      const logLine = JSON.stringify(logEntry) + '\n';
      
      fs.appendFileSync(logFile, logLine);
      
      // 如果是错误，也写入通用日志
      if (level === 'ERROR') {
        const generalLogFile = path.join(this.logDir, 'general.log');
        fs.appendFileSync(generalLogFile, logLine);
      }
    } catch (error) {
      console.error('写入日志文件失败:', error.message);
    }
  }
  
  info(message, data) { this.log('INFO', message, data); }
  warn(message, data) { this.log('WARN', message, data); }
  error(message, data) { this.log('ERROR', message, data); }
  debug(message, data) { this.log('DEBUG', message, data); }
}

// ========== 性能监控 ==========
class PerformanceMonitor {
  constructor() {
    this.metrics = {
      requests: 0,
      errors: 0,
      totalProcessingTime: 0,
      averageProcessingTime: 0,
      peakMemory: 0,
      startTime: Date.now(),
      requestsPerMinute: 0,
      lastMinuteRequests: []
    };
    
    this.startMemoryMonitoring();
    this.startRequestRateMonitoring();
  }
  
  startMemoryMonitoring() {
    setInterval(() => {
      const usage = process.memoryUsage();
      this.metrics.peakMemory = Math.max(this.metrics.peakMemory, usage.heapUsed);
      
      // 内存泄漏警告
      if (usage.heapUsed > 1024 * 1024 * 1024) { // 1GB
        logger.warn('内存使用过高', { memoryUsage: usage });
      }
    }, 5000);
  }
  
  startRequestRateMonitoring() {
    setInterval(() => {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      
      // 清理过期请求记录
      this.metrics.lastMinuteRequests = this.metrics.lastMinuteRequests.filter(
        timestamp => timestamp > oneMinuteAgo
      );
      
      this.metrics.requestsPerMinute = this.metrics.lastMinuteRequests.length;
    }, 10000); // 每10秒更新一次
  }
  
  recordRequest(processingTime) {
    this.metrics.requests++;
    this.metrics.totalProcessingTime += processingTime;
    this.metrics.averageProcessingTime = this.metrics.totalProcessingTime / this.metrics.requests;
    this.metrics.lastMinuteRequests.push(Date.now());
  }
  
  recordError() {
    this.metrics.errors++;
  }
  
  getMetrics() {
    const uptime = Date.now() - this.metrics.startTime;
    return {
      ...this.metrics,
      uptime,
      errorRate: this.metrics.errors / Math.max(this.metrics.requests, 1),
      currentMemory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
  }
  
  getHealthStatus() {
    const metrics = this.getMetrics();
    const isHealthy = 
      metrics.errorRate < 0.1 && // 错误率小于10%
      metrics.currentMemory.heapUsed < 2 * 1024 * 1024 * 1024 && // 内存小于2GB
      metrics.requestsPerMinute < 100; // 每分钟请求少于100
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      metrics
    };
  }
}

// ========== 资源管理器 ==========
class ResourceManager {
  constructor() {
    this.tempFiles = new Map();
    this.tempDirs = new Map();
    this.cleanupInterval = null;
    this.maxAge = 30 * 60 * 1000; // 30分钟
    this.maxTempFiles = 1000; // 最大临时文件数
    
    this.startCleanupScheduler();
    this.setupGracefulShutdown();
    this.startupCleanup();
  }
  
  startupCleanup() {
    // 启动时清理旧的临时文件
    logger.info('开始启动清理...');
    const uploadDir = path.join(os.tmpdir(), 'video_analyze');
    
    if (fs.existsSync(uploadDir)) {
      try {
        const files = fs.readdirSync(uploadDir);
        let cleanedCount = 0;
        
        for (const file of files) {
          const filePath = path.join(uploadDir, file);
          const stats = fs.statSync(filePath);
          const age = Date.now() - stats.mtime.getTime();
          
          if (age > this.maxAge) {
            if (stats.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
            cleanedCount++;
          }
        }
        
        logger.info('启动清理完成', { cleanedFiles: cleanedCount });
      } catch (error) {
        logger.warn('启动清理失败', { error: error.message });
      }
    }
  }
  
  registerTempFile(filePath) {
    this.tempFiles.set(filePath, {
      path: filePath,
      createdAt: Date.now(),
      size: this.getFileSize(filePath)
    });
    
    // 防止临时文件过多
    if (this.tempFiles.size > this.maxTempFiles) {
      this.forceCleanupOldest();
    }
  }
  
  registerTempDir(dirPath) {
    this.tempDirs.set(dirPath, {
      path: dirPath,
      createdAt: Date.now()
    });
  }
  
  getFileSize(filePath) {
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    } catch {
      return 0;
    }
  }
  
  forceCleanupOldest() {
    const sortedFiles = Array.from(this.tempFiles.values())
      .sort((a, b) => a.createdAt - b.createdAt);
    
    const toClean = sortedFiles.slice(0, Math.floor(this.maxTempFiles * 0.2));
    
    for (const fileInfo of toClean) {
      this.cleanupImmediate(fileInfo.path);
    }
  }
  
  startCleanupScheduler() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldFiles();
    }, 5 * 60 * 1000); // 每5分钟清理一次
  }
  
  cleanupOldFiles() {
    const now = Date.now();
    let cleanedFiles = 0;
    let cleanedDirs = 0;
    let totalSizeCleaned = 0;
    
    // 清理旧的临时文件
    for (const [filePath, fileInfo] of this.tempFiles) {
      if (now - fileInfo.createdAt > this.maxAge) {
        try {
          if (fs.existsSync(fileInfo.path)) {
            totalSizeCleaned += fileInfo.size;
            fs.unlinkSync(fileInfo.path);
            cleanedFiles++;
          }
          this.tempFiles.delete(filePath);
        } catch (error) {
          logger.warn('清理临时文件失败', { path: fileInfo.path, error: error.message });
        }
      }
    }
    
    // 清理旧的临时目录
    for (const [dirPath, dirInfo] of this.tempDirs) {
      if (now - dirInfo.createdAt > this.maxAge) {
        try {
          if (fs.existsSync(dirInfo.path)) {
            fs.rmSync(dirInfo.path, { recursive: true, force: true });
            cleanedDirs++;
          }
          this.tempDirs.delete(dirPath);
        } catch (error) {
          logger.warn('清理临时目录失败', { path: dirInfo.path, error: error.message });
        }
      }
    }
    
    if (cleanedFiles > 0 || cleanedDirs > 0) {
      logger.info('定期清理完成', { 
        cleanedFiles, 
        cleanedDirs, 
        totalSizeMB: (totalSizeCleaned / 1024 / 1024).toFixed(2)
      });
    }
  }
  
  setupGracefulShutdown() {
    const cleanup = (signal) => {
      logger.info(`收到${signal}信号，开始应用关闭清理...`);
      
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      
      let cleanedCount = 0;
      
      // 清理所有临时文件
      this.tempFiles.forEach((fileInfo, filePath) => {
        try {
          if (fs.existsSync(fileInfo.path)) {
            fs.unlinkSync(fileInfo.path);
            cleanedCount++;
          }
        } catch (error) {
          logger.warn('关闭时清理文件失败', { path: fileInfo.path, error: error.message });
        }
      });
      
      // 清理所有临时目录
      this.tempDirs.forEach((dirInfo, dirPath) => {
        try {
          if (fs.existsSync(dirInfo.path)) {
            fs.rmSync(dirInfo.path, { recursive: true, force: true });
            cleanedCount++;
          }
        } catch (error) {
          logger.warn('关闭时清理目录失败', { path: dirInfo.path, error: error.message });
        }
      });
      
      logger.info('应用清理完成', { cleanedCount });
      
      // 延迟退出确保日志写入
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    };
    
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGUSR2', () => cleanup('SIGUSR2')); // nodemon重启
  }
  
  cleanupImmediate(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
          this.tempDirs.delete(filePath);
        } else {
          fs.unlinkSync(filePath);
          this.tempFiles.delete(filePath);
        }
        return true;
      }
    } catch (error) {
      logger.warn('立即清理失败', { path: filePath, error: error.message });
      return false;
    }
    return false;
  }
  
  getStats() {
    const totalFiles = this.tempFiles.size;
    const totalDirs = this.tempDirs.size;
    const totalSize = Array.from(this.tempFiles.values())
      .reduce((sum, file) => sum + file.size, 0);
    
    return {
      tempFiles: totalFiles,
      tempDirs: totalDirs,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      oldestFile: totalFiles > 0 ? Math.min(
        ...Array.from(this.tempFiles.values()).map(f => f.createdAt)
      ) : null
    };
  }
}

// ========== 错误处理器 ==========
class ErrorHandler {
  static handle(error, context = {}) {
    const errorInfo = {
      message: error.message,
      stack: error.stack,
      code: error.code,
      context,
      timestamp: new Date().toISOString()
    };
    
    logger.error('处理错误', errorInfo);
    performanceMonitor.recordError();
    
    return this.getErrorResponse(error);
  }
  
  static getErrorResponse(error) {
    // 根据错误类型返回不同的响应
    if (error.name === 'ValidationError') {
      return { status: 400, code: 'VALIDATION_ERROR', message: error.message };
    }
    
    if (error.code === 'ENOENT') {
      return { status: 404, code: 'FILE_NOT_FOUND', message: '文件不存在' };
    }
    
    if (error.code === 'EACCES') {
      return { status: 403, code: 'ACCESS_DENIED', message: '文件访问被拒绝' };
    }
    
    if (error.message.includes('timeout') || error.code === 'ECONNABORTED') {
      return { status: 408, code: 'REQUEST_TIMEOUT', message: '请求超时' };
    }
    
    if (error.message.includes('ffmpeg')) {
      return { status: 500, code: 'VIDEO_PROCESSING_ERROR', message: '视频处理失败' };
    }
    
    // URL相关错误
    if (error.message.includes('URL') || error.message.includes('下载')) {
      return { status: 400, code: 'VIDEO_DOWNLOAD_ERROR', message: error.message };
    }
    
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return { status: 502, code: 'EXTERNAL_SERVICE_ERROR', message: '无法连接到视频源' };
    }
    
    // 默认服务器错误
    return { status: 500, code: 'INTERNAL_ERROR', message: '服务器内部错误' };
  }
}

// ========== 全局实例 ==========
const logger = new Logger();
const performanceMonitor = new PerformanceMonitor();
const resourceManager = new ResourceManager();

// ========== 环境变量配置 ==========
const VOICE_APPID = process.env.VOICE_APPID || 'e8f592b9';
const VOICE_APIKey = process.env.VOICE_API_KEY || 'e22b24049f00d5729427119b825f4a71';
const VOICE_APISecret = process.env.VOICE_API_SECRET || 'MWMwMDI0MGJkYzY2ZjkyODg5ODg2ZTg4';

const FACE_API_URL = "http://tupapi.xfyun.cn/v1/expression";
const FACE_APPID = process.env.FACE_APPID || "e8f592b9";
const FACE_SECRET = process.env.FACE_SECRET || "7a716e2b437bbf31dd9f6ebc07978fe1";

// 请求超时配置
const REQUEST_TIMEOUT = 30000; // 30秒
const WS_TIMEOUT = 30000; // WebSocket超时
const DOWNLOAD_TIMEOUT = process.env.DOWNLOAD_TIMEOUT || 60000; // 60秒下载超时
const MAX_DOWNLOAD_SIZE = process.env.MAX_DOWNLOAD_SIZE || 100 * 1024 * 1024; // 100MB

// ========== Express配置 ==========
const app = express();
const uploadDir = path.join(os.tmpdir(), 'video_analyze');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 请求速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 每个IP限制100个请求
  message: {
    success: false,
    error: '请求过于频繁，请稍后再试',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('触发速率限制', { ip: req.ip, userAgent: req.get('User-Agent') });
    res.status(429).json({
      success: false,
      error: '请求过于频繁，请稍后再试',
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }
});

// 分析接口的特殊限制
const analyzeLimit = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 10, // 每分钟最多10次分析
  message: {
    success: false,
    error: '分析请求过于频繁，请等待后重试',
    code: 'ANALYZE_RATE_LIMIT'
  }
});

// 中间件配置
app.use(express.json({ 
  limit: '10mb', // 降低JSON限制，因为不再需要处理大的Base64数据
  verify: (req, res, buf) => {
    // 验证JSON格式
    try {
      JSON.parse(buf);
    } catch (e) {
      const error = new Error('Invalid JSON format');
      error.status = 400;
      throw error;
    }
  }
}));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substr(2, 9);
  
  req.requestId = requestId;
  req.startTime = start;
  
  logger.info('收到请求', {
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    contentLength: req.get('Content-Length')
  });
  
  // 响应完成时记录
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    
    logger.info('请求完成', {
      requestId,
      statusCode,
      duration: `${duration}ms`,
      success: statusCode < 400
    });
    
    if (statusCode < 400) {
      performanceMonitor.recordRequest(duration);
    }
  });
  
  next();
});

// 改进的CORS配置
app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:5500',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://localhost:3001',
    'http://127.0.0.1:3001'
  ];
  
  const origin = req.headers.origin;
  
  // 开发环境允许所有origin，生产环境严格限制
  if (process.env.NODE_ENV === 'development') {
    res.header("Access-Control-Allow-Origin", origin || "*");
  } else if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Max-Age", "86400");
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// 全局速率限制
app.use(limiter);

// ========== ffmpeg配置 ==========
ffmpeg.setFfmpegPath(ffmpegPath);

// ========== 工具函数 ==========

// 从URL获取视频扩展名
function getVideoExtensionFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const ext = path.extname(pathname).toLowerCase();
    const allowedExts = ['.mp4', '.webm', '.ogg', '.avi', '.mov'];
    return allowedExts.includes(ext) ? ext : null;
  } catch {
    return null;
  }
}

// 从Content-Type获取扩展名
function getExtensionFromContentType(contentType) {
  if (!contentType) return null;
  
  const typeMap = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/ogg': '.ogg',
    'video/avi': '.avi',
    'video/mov': '.mov',
    'video/quicktime': '.mov'
  };
  
  for (const [type, ext] of Object.entries(typeMap)) {
    if (contentType.includes(type)) {
      return ext;
    }
  }
  return null;
}

// 从URL下载视频文件
async function downloadVideoFromUrl(videoUrl, filename, requestId) {
  try {
    logger.info('开始下载视频文件', { videoUrl, requestId });
    
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT,
      maxContentLength: MAX_DOWNLOAD_SIZE,
      headers: {
        'User-Agent': 'VideoAnalysisServer/1.0',
        'Accept': 'video/*,*/*',
      }
    });
    
    // 验证Content-Type
    const contentType = response.headers['content-type'];
    const allowedTypes = [
      'video/mp4', 'video/webm', 'video/ogg', 
      'video/avi', 'video/mov', 'video/quicktime',
      'application/octet-stream' // 某些服务器可能返回这个
    ];
    
    if (contentType && !allowedTypes.some(type => contentType.includes(type))) {
      throw new Error(`不支持的视频格式: ${contentType}`);
    }
    
    // 检查文件大小
    const contentLength = response.headers['content-length'];
    if (contentLength && parseInt(contentLength) > MAX_DOWNLOAD_SIZE) {
      throw new Error(`视频文件过大: ${(parseInt(contentLength) / 1024 / 1024).toFixed(2)}MB，超过100MB限制`);
    }
    
    // 生成临时文件路径
    const ext = getVideoExtensionFromUrl(videoUrl) || getExtensionFromContentType(contentType) || '.mp4';
    const safeFilename = `url_video_${Date.now()}_${Math.floor(Math.random()*10000)}_${requestId}${ext}`;
    const tempVideoPath = path.join(uploadDir, safeFilename);
    
    // 下载文件
    const writer = fs.createWriteStream(tempVideoPath);
    let downloadedSize = 0;
    
    response.data.on('data', (chunk) => {
      downloadedSize += chunk.length;
      if (downloadedSize > MAX_DOWNLOAD_SIZE) {
        writer.destroy();
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        throw new Error('下载过程中检测到文件过大');
      }
    });
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        // 验证下载的文件
        const stats = fs.statSync(tempVideoPath);
        if (stats.size === 0) {
          fs.unlinkSync(tempVideoPath);
          reject(new Error('下载的视频文件为空'));
          return;
        }
        
        resourceManager.registerTempFile(tempVideoPath);
        logger.info('视频文件下载完成', { 
          path: tempVideoPath, 
          size: stats.size,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          requestId 
        });
        resolve(tempVideoPath);
      });
      
      writer.on('error', (error) => {
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        reject(new Error(`文件写入失败: ${error.message}`));
      });
      
      response.data.on('error', (error) => {
        writer.destroy();
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        reject(new Error(`视频下载失败: ${error.message}`));
      });
    });
    
  } catch (error) {
    if (error.response) {
      throw new Error(`下载失败: HTTP ${error.response.status} - ${error.response.statusText}`);
    } else if (error.request) {
      throw new Error('网络请求失败，请检查URL是否可访问');
    } else {
      throw new Error(`下载视频失败: ${error.message}`);
    }
  }
}

// 流式文件验证
function validateVideoFileStream(videoPath) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('视频验证超时'));
    }, 10000);
    
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      clearTimeout(timeout);
      
      if (err) {
        reject(new Error('视频文件损坏或格式不支持: ' + err.message));
        return;
      }
      
      if (!metadata || !metadata.streams) {
        reject(new Error('无法读取视频元数据'));
        return;
      }
      
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      
      // 检查视频流是否有效
      if (videoStream && videoStream.duration === '0.000000') {
        reject(new Error('视频流时长为0，文件可能损坏'));
        return;
      }
      
      const videoInfo = {
        duration: parseFloat(metadata.format.duration) || 0,
        hasVideo: !!videoStream,
        hasAudio: !!audioStream,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        bitrate: parseInt(metadata.format.bit_rate) || 0,
        size: parseInt(metadata.format.size) || 0
      };
      
      logger.info('视频验证成功', videoInfo);
      resolve(videoInfo);
    });
  });
}

// 改进的帧提取函数
function extractFramesOptimized(videoPath, framesDir) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('视频帧提取超时'));
    }, REQUEST_TIMEOUT);

    try {
      fs.mkdirSync(framesDir, { recursive: true });
      resourceManager.registerTempDir(framesDir);
      
      const command = ffmpeg(videoPath)
        .output(path.join(framesDir, 'frame_%04d.jpg'))
        .outputOptions([
          '-vf', 'fps=1,scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2',
          '-q:v', '2',
          '-frames:v', '30'
        ]);
      
      command.on('end', () => {
        clearTimeout(timeout);
        
        // 验证提取的帧
        try {
          const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
          if (files.length === 0) {
            reject(new Error('未提取到任何视频帧'));
          } else {
            logger.info('帧提取完成', { frameCount: files.length });
            resolve(files.length);
          }
        } catch (error) {
          reject(new Error('读取提取的帧文件失败: ' + error.message));
        }
      });
      
      command.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`视频帧提取失败: ${err.message}`));
      });
      
      command.on('progress', (progress) => {
        if (progress.percent) {
          logger.debug('帧提取进度', { percent: progress.percent.toFixed(1) });
        }
      });
      
      command.run();
    } catch (error) {
      clearTimeout(timeout);
      reject(new Error(`视频帧提取初始化失败: ${error.message}`));
    }
  });
}

// 改进的音频提取函数
function extractAudioOptimized(videoPath, audioMp3Path) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('音频提取超时'));
    }, REQUEST_TIMEOUT);

    try {
      const command = ffmpeg(videoPath)
        .output(audioMp3Path)
        .audioCodec('libmp3lame')
        .audioFrequency(16000)
        .audioChannels(1)
        .audioBitrate('96k')
        .noVideo()
        .outputOptions([
          '-af', 'volume=2.0,highpass=f=80,lowpass=f=8000',
          '-ac', '1'
        ]);
      
      command.on('end', () => {
        clearTimeout(timeout);
        
        // 验证输出文件
        if (fs.existsSync(audioMp3Path)) {
          const stats = fs.statSync(audioMp3Path);
          if (stats.size > 0) {
            resourceManager.registerTempFile(audioMp3Path);
            logger.info('音频提取完成', { size: stats.size });
            resolve();
          } else {
            reject(new Error('音频文件为空'));
          }
        } else {
          reject(new Error('音频文件生成失败'));
        }
      });
      
      command.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`音频提取失败: ${err.message}`));
      });
      
      command.on('progress', (progress) => {
        if (progress.percent) {
          logger.debug('音频提取进度', { percent: progress.percent.toFixed(1) });
        }
      });
      
      command.run();
    } catch (error) {
      clearTimeout(timeout);
      reject(new Error(`音频提取初始化失败: ${error.message}`));
    }
  });
}

// 改进的讯飞语音识别相关函数
function getVoiceAuthUrl() {
  try {
    const host = "iat-api.xfyun.cn";
    const date = new Date().toUTCString();
    const requestLine = "GET /v2/iat HTTP/1.1";
    const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
    const signatureSha = crypto.createHmac('sha256', VOICE_APISecret).update(signatureOrigin).digest('base64');
    const authorizationOrigin = `api_key="${VOICE_APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    return `wss://${host}/v2/iat?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
  } catch (error) {
    throw new Error(`语音认证URL生成失败: ${error.message}`);
  }
}

function* mp3AudioFrameGenerator(buffer, frameSize = 8192) {
  let offset = 0;
  while (offset < buffer.length) {
    const end = Math.min(offset + frameSize, buffer.length);
    const frame = buffer.slice(offset, end);
    const isLast = end === buffer.length;
    yield { frame, isLast };
    offset = end;
  }
}

function detectMp3Bitrate(buffer) {
  try {
    const len = Math.min(buffer.length, 1024 * 1024);
    let idx = 0;
    while (idx < len - 4) {
      if (buffer[idx] === 0xFF && (buffer[idx + 1] & 0xE0) === 0xE0) {
        try {
          const frame = mp3Parser.readFrameHeader(buffer, idx);
          if (frame && frame.bitrate) {
            return Math.round(frame.bitrate / 1000);
          }
        } catch (e) {
          // 继续寻找下一个帧
        }
      }
      idx++;
    }
  } catch (error) {
    logger.warn('MP3比特率检测失败，使用默认值', { error: error.message });
  }
  return 128; // 默认比特率
}

function splitMp3BufferByDuration(buffer, minSeconds = 40, maxSeconds = 60, bitrateKbps = 128) {
  try {
    const bytesPerSecond = (bitrateKbps * 1000) / 8;
    const minBytes = Math.floor(minSeconds * bytesPerSecond);
    const maxBytes = Math.floor(maxSeconds * bytesPerSecond);

    let chunks = [];
    let offset = 0;
    
    while (offset < buffer.length) {
      let end = Math.min(offset + maxBytes, buffer.length);
      let chunk = buffer.slice(offset, end);

      if (chunk.length < minBytes && chunks.length > 0) {
        // 合并到上一个块
        let last = chunks.pop();
        let merged = Buffer.concat([last, chunk]);
        chunks.push(merged);
        break;
      } else {
        chunks.push(chunk);
        offset += chunk.length;
      }
    }
    
    return chunks;
  } catch (error) {
    throw new Error(`音频分块失败: ${error.message}`);
  }
}

// 改进的WebSocket语音识别
function startIatMp3Buffer(audioBuffer) {
  return new Promise((resolve, reject) => {
    let ws;
    let timeout;
    let interval;
    let connectionStartTime = Date.now();
    
    // 设置总体超时
    timeout = setTimeout(() => {
      if (ws) ws.close();
      if (interval) clearInterval(interval);
      reject(new Error(`语音识别超时 (${WS_TIMEOUT}ms)`));
    }, WS_TIMEOUT);

    try {
      const wsUrl = getVoiceAuthUrl();
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timeout);
      return reject(new Error(`WebSocket连接创建失败: ${err.message}`));
    }

    let resultArr = [];
    let isConnected = false;

    ws.on('open', () => {
      isConnected = true;
      const connectionTime = Date.now() - connectionStartTime;
      logger.debug('WebSocket连接成功', { connectionTime });
      
      try {
        const gen = mp3AudioFrameGenerator(audioBuffer);
        const first = gen.next().value;
        
        if (!first) {
          clearTimeout(timeout);
          ws.close();
          return reject(new Error('音频数据为空'));
        }

        // 发送第一帧
        const firstMessage = {
          common: { app_id: VOICE_APPID },
          business: {
            language: "zh_cn",
            domain: "iat",
            accent: "mandarin",
            dwa: "wpgs",
            nbest: 1
          },
          data: {
            status: 0,
            format: "mp3",
            encoding: "mp3",
            audio: first.frame.toString('base64')
          }
        };
        
        ws.send(JSON.stringify(firstMessage));

        // 定期发送后续帧
        interval = setInterval(() => {
          try {
            const next = gen.next();
            if (next.done) {
              clearInterval(interval);
              interval = null;
              return;
            }
            
            if (ws.readyState === WebSocket.OPEN) {
              const message = {
                data: {
                  status: next.value.isLast ? 2 : 1,
                  format: "mp3",
                  encoding: "mp3",
                  audio: next.value.frame.toString('base64')
                }
              };
              ws.send(JSON.stringify(message));
            }
            
            if (next.value.isLast) {
              clearInterval(interval);
              interval = null;
            }
          } catch (err) {
            if (interval) {
              clearInterval(interval);
              interval = null;
            }
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`发送音频数据失败: ${err.message}`));
          }
        }, 40);
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`音频数据处理失败: ${err.message}`));
      }
    });

    function getText(wsArr) {
      try {
        return wsArr.map(item => 
          item.cw ? item.cw.map(cw => cw.w || '').join('') : ''
        ).join('');
      } catch (error) {
        logger.warn('文本提取失败', { error: error.message });
        return '';
      }
    }

    ws.on('message', (data) => {
      try {
        const res = JSON.parse(data);
        
        if (res.code !== 0) {
          clearTimeout(timeout);
          if (interval) clearInterval(interval);
          ws.close();
          reject(new Error(`语音识别API错误: ${res.message || '未知错误'} (代码: ${res.code})`));
          return;
        }
        
        if (res.data && res.data.result) {
          const { ws: wsArr, pgs, rg } = res.data.result;
          if (pgs === "apd") {
            resultArr.push(getText(wsArr));
          } else if (pgs === "rpl" && Array.isArray(rg) && rg.length === 2) {
            const [start, end] = rg;
            while (resultArr.length < end) resultArr.push('');
            for (let i = start; i < end; i++) {
              resultArr[i] = '';
            }
            resultArr[start] = getText(wsArr);
          } else {
            resultArr.push(getText(wsArr));
          }
        }
        
        if (res.data && res.data.status === 2) {
          clearTimeout(timeout);
          if (interval) clearInterval(interval);
          ws.close();
          const finalText = resultArr.join('').trim();
          logger.info('语音识别完成', { textLength: finalText.length });
          resolve(finalText);
        }
      } catch (err) {
        clearTimeout(timeout);
        if (interval) clearInterval(interval);
        ws.close();
        reject(new Error(`响应解析失败: ${err.message}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      const errorMsg = isConnected ? 
        `WebSocket通信错误: ${err.message}` : 
        `WebSocket连接失败: ${err.message}`;
      reject(new Error(errorMsg));
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      logger.debug('WebSocket关闭', { code, reason: reason?.toString() });
    });
  });
}

async function recognizeMp3File(localMp3Path) {
  try {
    if (!fs.existsSync(localMp3Path)) {
      throw new Error('音频文件不存在: ' + localMp3Path);
    }
    
    const stats = fs.statSync(localMp3Path);
    if (stats.size === 0) {
      throw new Error('音频文件为空');
    }
    
    if (stats.size > 50 * 1024 * 1024) { // 50MB限制
      throw new Error('音频文件过大，超过50MB限制');
    }
    
    const buffer = fs.readFileSync(localMp3Path);
    const bitrateKbps = detectMp3Bitrate(buffer);
    const chunks = splitMp3BufferByDuration(buffer, 40, 60, bitrateKbps);
    
    logger.info('开始语音识别', { 
      fileSize: stats.size, 
      bitrate: bitrateKbps, 
      chunks: chunks.length 
    });
    
    let results = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        logger.debug(`处理音频块 ${i + 1}/${chunks.length}`);
        const text = await startIatMp3Buffer(chunks[i]);
        results.push(text);
        
        // 块之间短暂延迟避免频率限制
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (e) {
        logger.warn(`音频块 ${i + 1} 识别失败`, { error: e.message });
        results.push('');
      }
    }
    
    const finalResult = results.join('').trim();
    logger.info('语音识别完成', { resultLength: finalResult.length });
    return finalResult;
  } catch (error) {
    throw new Error(`语音识别失败: ${error.message}`);
  }
}

// 改进的讯飞表情分析相关函数
function generateFaceSignature(imageName) {
  try {
    const curTime = new Date().toUTCString();
    const xParam = Buffer.from(JSON.stringify({ 
      image_name: imageName, 
      image_url: "" 
    })).toString("base64");
    const stringToSign = `host: tupapi.xfyun.cn\ndate: ${curTime}\nPOST /v1/expression HTTP/1.1`;
    const signature = crypto.createHmac("sha256", FACE_SECRET).update(stringToSign).digest("base64");
    return { curTime, xParam, signature };
  } catch (error) {
    throw new Error(`表情分析签名生成失败: ${error.message}`);
  }
}

async function analyzeImageEmotion(imgPath) {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(imgPath)) {
        throw new Error(`图像文件不存在: ${imgPath}`);
      }
      
      const stats = fs.statSync(imgPath);
      if (stats.size === 0) {
        throw new Error('图像文件为空');
      }
      
      if (stats.size > 10 * 1024 * 1024) { // 10MB限制
        throw new Error('图像文件过大，超过10MB限制');
      }
      
      const fileName = path.basename(imgPath);
      const imageBuffer = fs.readFileSync(imgPath);
      const { curTime, xParam, signature } = generateFaceSignature(fileName);
      
      const headers = {
        "X-Appid": FACE_APPID,
        "X-CurTime": curTime,
        "X-CheckSum": signature,
        "X-Param": xParam,
        "Content-Type": "image/jpeg",
        "User-Agent": "VideoAnalysisServer/1.0"
      };
      
      const response = await axios.post(FACE_API_URL, imageBuffer, { 
        headers,
        timeout: REQUEST_TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (status) => status < 500 // 只对5xx错误进行重试
      });
      
      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error(`API返回错误状态: ${response.status}`);
      }
      
    } catch (error) {
      lastError = error;
      
      if (error.response) {
        const errorMsg = `表情分析API错误: ${error.response.status} - ${error.response.data?.message || '未知错误'}`;
        
        // 对于4xx错误不重试
        if (error.response.status >= 400 && error.response.status < 500) {
          throw new Error(errorMsg);
        }
        
        logger.warn(`表情分析失败，尝试 ${attempt}/${maxRetries}`, { 
          error: errorMsg,
          status: error.response.status
        });
      } else if (error.request) {
        logger.warn(`表情分析网络错误，尝试 ${attempt}/${maxRetries}`, {
          error: '服务无响应',
          timeout: REQUEST_TIMEOUT
        });
      } else {
        logger.warn(`表情分析处理错误，尝试 ${attempt}/${maxRetries}`, {
          error: error.message
        });
      }
      
      // 最后一次尝试失败则抛出错误
      if (attempt === maxRetries) {
        if (error.response) {
          throw new Error(`表情分析API错误: ${error.response.status} - ${error.response.data?.message || '未知错误'}`);
        } else if (error.request) {
          throw new Error('表情分析服务无响应，请检查网络连接');
        } else {
          throw new Error(`表情分析失败: ${error.message}`);
        }
      }
      
      // 重试前等待
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// ========== 改进的通用视频处理函数 ==========
async function processVideoWithLogging(videoPath, res, requestId) {
  const startTime = Date.now();
  const framesDir = path.join(uploadDir, `frames_${Date.now()}_${Math.floor(Math.random()*10000)}_${requestId}`);
  const audioMp3Path = path.join(uploadDir, `${Date.now()}_audio_${requestId}.mp3`);

  try {
    logger.info('开始处理视频', { videoPath, requestId });
    
    // 验证视频文件
    const stats = fs.statSync(videoPath);
    if (stats.size === 0) {
      throw new Error('视频文件为空');
    }
    
    logger.info('视频文件大小检查通过', { 
      sizeMB: (stats.size / 1024 / 1024).toFixed(2),
      requestId 
    });

    // 验证视频完整性
    logger.info('开始验证视频完整性...', { requestId });
    let videoInfo;
    try {
      videoInfo = await validateVideoFileStream(videoPath);
      logger.info('视频验证通过', { videoInfo, requestId });
    } catch (error) {
      throw new Error(`视频文件验证失败: ${error.message}`);
    }

    // 1. 抽帧
    logger.info('开始抽帧...', { requestId });
    const frameCount = await extractFramesOptimized(videoPath, framesDir);
    logger.info('抽帧完成', { frameCount, requestId });

    // 2. 提取音频（仅当有音频流时）
    let audioPath = null;
    if (videoInfo.hasAudio) {
      logger.info('开始提取音频...', { requestId });
      try {
        await extractAudioOptimized(videoPath, audioMp3Path);
        audioPath = audioMp3Path;
        logger.info('音频提取完成', { requestId });
      } catch (error) {
        logger.warn('音频提取失败，跳过语音识别', { error: error.message, requestId });
      }
    } else {
      logger.info('视频中没有音频流，跳过音频处理', { requestId });
    }

    // 3. 表情分析
    logger.info('开始表情分析...', { requestId });
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)?.[0] || '0');
        const numB = parseInt(b.match(/\d+/)?.[0] || '0');
        return numA - numB;
      });
    
    logger.info(`找到视频帧`, { frameCount: frameFiles.length, requestId });
    const emotionResults = [];
    
    // 并发处理表情分析（限制并发数避免过载）
    const concurrencyLimit = 2; // 降低并发数
    for (let i = 0; i < frameFiles.length; i += concurrencyLimit) {
      const batch = frameFiles.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (frame, batchIndex) => {
        const frameIndex = i + batchIndex;
        try {
          logger.debug(`分析第 ${frameIndex + 1}/${frameFiles.length} 帧: ${frame}`, { requestId });
          const imgPath = path.join(framesDir, frame);
          const emotion = await analyzeImageEmotion(imgPath);
          return { 
            frame, 
            emotion,
            timestamp: frameIndex,
            index: frameIndex
          };
        } catch (error) {
          logger.warn(`表情分析失败 - 帧: ${frame}`, { error: error.message, requestId });
          return { 
            frame, 
            emotion: { 
              error: error.message,
              code: 'EMOTION_ANALYSIS_FAILED'
            },
            timestamp: frameIndex,
            index: frameIndex
          };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      emotionResults.push(...batchResults);
      
      // 批次间延迟增加到500ms
      if (i + concurrencyLimit < frameFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 按索引排序结果
    emotionResults.sort((a, b) => a.index - b.index);
    
    // 统计分析结果
    const successfulFrames = emotionResults.filter(r => !r.emotion.error).length;
    const failedFrames = emotionResults.filter(r => r.emotion.error).length;
    
    logger.info('表情分析完成', { 
      requestId,
      totalFrames: frameFiles.length,
      successfulFrames,
      failedFrames,
      successRate: (successfulFrames / frameFiles.length * 100).toFixed(1) + '%'
    });

    // 4. 语音识别
    let asrText = '';
    let asrError = null;
    
    if (audioPath && fs.existsSync(audioPath)) {
      logger.info('开始语音识别...', { requestId });
      try {
        asrText = await recognizeMp3File(audioPath);
        logger.info('语音识别完成', { textLength: asrText.length, requestId });
      } catch (error) {
        logger.warn('语音识别失败', { error: error.message, requestId });
        asrError = {
          message: error.message,
          code: 'ASR_FAILED'
        };
      }
    } else {
      logger.info('跳过语音识别（无音频文件）', { requestId });
      asrError = {
        message: '视频中无音频数据',
        code: 'NO_AUDIO'
      };
    }

    // 5. 返回结果
    const processingTime = Date.now() - startTime;
    const result = {
      success: true,
      emotionTimeline: emotionResults,
      asrText,
      asrError,
      processedFrames: frameFiles.length,
      analysisStats: {
        totalFrames: frameFiles.length,
        successfulFrames,
        failedFrames,
        successRate: (successfulFrames / frameFiles.length * 100).toFixed(1) + '%'
      },
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString(),
      requestId,
      videoInfo: {
        ...videoInfo,
        size: stats.size,
        sizeMB: (stats.size / 1024 / 1024).toFixed(2)
      }
    };
    
    logger.info('视频处理完成', { processingTime, requestId });
    performanceMonitor.recordRequest(processingTime);
    res.json(result);
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    const errorResponse = ErrorHandler.handle(error, { 
      requestId,
      processingTime,
      videoPath 
    });
    
    logger.error('视频处理失败', { 
      error: error.message, 
      processingTime,
      requestId 
    });
    
    res.status(errorResponse.status).json({ 
      success: false, 
      error: errorResponse.message,
      code: errorResponse.code,
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString(),
      requestId
    });
  } finally {
    // 使用响应完成事件进行清理
    res.on('finish', () => {
      setTimeout(() => {
        resourceManager.cleanupImmediate(videoPath);
        resourceManager.cleanupImmediate(audioMp3Path);
        resourceManager.cleanupImmediate(framesDir);
      }, 1000);
    });
  }
}

// ========== API路由 ==========

// 健康检查接口
app.get('/health', (req, res) => {
  const health = performanceMonitor.getHealthStatus();
  const resourceStats = resourceManager.getStats();
  
  res.status(health.status === 'healthy' ? 200 : 503).json({ 
    status: health.status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      }
    },
    performance: health.metrics,
    resources: resourceStats
  });
});

// 服务器信息接口
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Video Analysis Server',
    version: '4.0.0', // 版本更新为4.0.0表示重大架构更改
    timestamp: new Date().toISOString(),
    capabilities: {
      videoFormats: ['mp4', 'webm', 'ogg', 'avi', 'mov'],
      maxFileSize: '100MB',
      inputMethod: 'url-only', // 新增：说明只支持URL输入
      features: [
        'emotion-analysis', 
        'speech-recognition', 
        'frame-extraction', 
        'video-validation',
        'rate-limiting',
        'performance-monitoring',
        'resource-management',
        'url-video-processing'
      ]
    },
    endpoints: {
      videoAnalysis: '/api/video/analyze', // 唯一的视频分析接口
    },
    limits: {
      requestsPerWindow: '100/15min',
      analysisRequests: '10/min',
      maxVideoSize: '100MB',
      maxProcessingTime: '120s',
      downloadTimeout: '60s'
    }
  });
});

// 性能指标接口
app.get('/api/metrics', (req, res) => {
  // 简单的认证检查
  const authToken = req.headers.authorization;
  if (process.env.METRICS_TOKEN && authToken !== `Bearer ${process.env.METRICS_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const metrics = performanceMonitor.getMetrics();
  const resourceStats = resourceManager.getStats();
  
  res.json({
    performance: metrics,
    resources: resourceStats,
    system: {
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid
    }
  });
});

// 唯一的视频分析接口 - 只支持URL方式
app.post('/api/video/analyze', analyzeLimit, async (req, res) => {
  let tempVideoPath = null;
  
  try {
    const { videoUrl, filename = 'video_from_url' } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ 
        success: false,
        error: '请提供视频URL',
        code: 'MISSING_VIDEO_URL',
        requestId: req.requestId      });
    }
    
    // 验证URL格式
    let parsedUrl;
    try {
      parsedUrl = new URL(videoUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('仅支持HTTP和HTTPS协议');
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: '无效的视频URL格式',
        code: 'INVALID_VIDEO_URL',
        requestId: req.requestId
      });
    }
    
    // 下载视频文件
    logger.info('开始从URL下载视频', { videoUrl, requestId: req.requestId });
    tempVideoPath = await downloadVideoFromUrl(videoUrl, filename, req.requestId);
    
    await processVideoWithLogging(tempVideoPath, res, req.requestId);
    
  } catch (error) {
    logger.error('URL视频处理错误', { error: error.message, requestId: req.requestId });
    
    // 清理临时文件
    if (tempVideoPath) {
      resourceManager.cleanupImmediate(tempVideoPath);
    }
    
    const errorResponse = ErrorHandler.handle(error, { requestId: req.requestId });
    res.status(errorResponse.status).json({ 
      success: false,
      error: errorResponse.message,
      code: errorResponse.code,
      requestId: req.requestId
    });
  }
});

// ========== 错误处理中间件 ==========
app.use((error, req, res, next) => {
  const errorResponse = ErrorHandler.handle(error, { 
    url: req.url,
    method: req.method,
    requestId: req.requestId
  });
  
  res.status(errorResponse.status).json({ 
    success: false,
    error: errorResponse.message,
    code: errorResponse.code,
    timestamp: new Date().toISOString(),
    requestId: req.requestId || 'unknown'
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在',
    code: 'NOT_FOUND',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      'GET /health',
      'GET /api/info', 
      'GET /api/metrics',
      'POST /api/video/analyze'
    ]
  });
});

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  console.error('未捕获异常:', error.message);
  console.error('堆栈:', error.stack);
  
  // 优雅关闭
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason?.message || reason);
});

// 服务器启动
const port = process.env.PORT || 3100;
const server = app.listen(port, () => {
  console.log(`=== Video Analysis Server Started (URL-only Mode) ===`);
  console.log(`Server URL: http://localhost:${port}`);
  console.log(`Health Check: http://localhost:${port}/health`);
  console.log(`Server Info: http://localhost:${port}/api/info`);
  console.log(`Video Analysis: http://localhost:${port}/api/video/analyze`);
  console.log(`Upload Directory: ${uploadDir}`);
  console.log(`Process ID: ${process.pid}`);
  console.log(`Node Version: ${process.version}`);
  console.log(`Input Method: URL-only`);
  console.log(`=== Ready to accept requests ===`);
});

// 服务器优雅关闭
const gracefulShutdown = (signal) => {
  console.log(`\n收到${signal}信号，开始优雅关闭服务器...`);
  
  server.close((err) => {
    if (err) {
      console.error('服务器关闭错误:', err.message);
      process.exit(1);
    }
    
    console.log('服务器已停止接收新连接');
    
    // 等待现有连接完成
    setTimeout(() => {
      console.log('服务器优雅关闭完成');
      process.exit(0);
    }, 10000);
  });
  
  // 强制关闭超时
  setTimeout(() => {
    console.warn('强制关闭服务器');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon重启

// 处理服务器错误
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用`);
    process.exit(1);
  } else {
    console.error('服务器错误:', error.message);
  }
});

// 定期性能监控
setInterval(() => {
  const memoryUsage = process.memoryUsage();
  const memoryMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
  
  if (memoryMB > 1000) { // 内存使用超过1GB时警告（调整为更适合视频处理的阈值）
    console.warn(`内存使用较高: ${memoryMB}MB`);
  }
  
  // 只在开发模式下详细输出
  if (process.env.NODE_ENV === 'development') {
    console.log(`内存使用: ${memoryMB}MB | 运行时间: ${Math.floor(process.uptime())}秒`);
  }
}, 60000); // 每分钟检查一次

module.exports = app;
// 添加到processvideo.js文件末尾
module.exports = app;
module.exports.Logger = Logger;
module.exports.ResourceManager = ResourceManager; 
module.exports.ErrorHandler = ErrorHandler;
module.exports.PerformanceMonitor = PerformanceMonitor;
