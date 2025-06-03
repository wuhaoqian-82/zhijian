const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const axios = require("axios");
const crypto = require("crypto");
const WebSocket = require("ws");

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

// ========== Express配置 ==========
const app = express();
const uploadDir = path.join(os.tmpdir(), 'video_analyze');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 文件存储配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.webm';
    const basename = path.basename(file.originalname, ext) || 'recorded_video';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, basename + '-' + uniqueSuffix + ext);
  }
});

// 文件上传配置 - 支持摄像头录制的格式
const upload = multer({ 
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB 限制
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4', 
      'video/webm',
      'video/ogg',
      'video/avi', 
      'video/mov',
      'video/quicktime'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式。支持的格式：MP4, WebM, OGG, AVI, MOV'));
    }
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'video/*', limit: '100mb' }));

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
  if (allowedOrigins.includes(origin) || !origin) {
    res.header("Access-Control-Allow-Origin", origin || "*");
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

// ========== ffmpeg配置 ==========
ffmpeg.setFfmpegPath(ffmpegPath);

// ========== 改进的工具函数 ==========

// 验证视频文件完整性
function validateVideoFile(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
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
      
      console.log('视频信息:', {
        duration: metadata.format.duration,
        size: metadata.format.size,
        hasVideo: !!videoStream,
        hasAudio: !!audioStream,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name
      });
      
      resolve({
        duration: metadata.format.duration,
        hasVideo: !!videoStream,
        hasAudio: !!audioStream,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name
      });
    });
  });
}

function extractFrames(videoPath, framesDir) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('视频帧提取超时'));
    }, REQUEST_TIMEOUT);

    try {
      fs.mkdirSync(framesDir, { recursive: true });
      
      ffmpeg(videoPath)
        .output(path.join(framesDir, 'frame_%04d.jpg'))
        .outputOptions([
          '-vf', 'fps=1,scale=640:480', // 添加缩放以确保一致性
          '-q:v', '2',  // 高质量
          '-frames:v', '30' // 最多30帧，避免处理时间过长
        ])
        .on('end', () => {
          clearTimeout(timeout);
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`视频帧提取失败: ${err.message}`));
        })
        .on('progress', (progress) => {
          console.log(`帧提取进度: ${progress.percent?.toFixed(1) || 0}%`);
        })
        .run();
    } catch (error) {
      clearTimeout(timeout);
      reject(new Error(`视频帧提取初始化失败: ${error.message}`));
    }
  });
}

function extractAudioMp3(videoPath, audioMp3Path) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('音频提取超时'));
    }, REQUEST_TIMEOUT);

    try {
      ffmpeg(videoPath)
        .output(audioMp3Path)
        .audioCodec('libmp3lame')
        .audioFrequency(16000)
        .audioChannels(1)
        .audioBitrate('96k')
        .noVideo()
        .outputOptions([
          '-af', 'volume=2.0', // 增加音量
          '-ac', '1' // 强制单声道
        ])
        .on('end', () => {
          clearTimeout(timeout);
          // 检查输出文件是否存在且有内容
          if (fs.existsSync(audioMp3Path)) {
            const stats = fs.statSync(audioMp3Path);
            if (stats.size > 0) {
              resolve();
            } else {
              reject(new Error('音频文件为空'));
            }
          } else {
            reject(new Error('音频文件生成失败'));
          }
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`音频提取失败: ${err.message}`));
        })
        .on('progress', (progress) => {
          console.log(`音频提取进度: ${progress.percent?.toFixed(1) || 0}%`);
        })
        .run();
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
    console.warn('MP3比特率检测失败，使用默认值:', error.message);
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

function startIatMp3Buffer(audioBuffer) {
  return new Promise((resolve, reject) => {
    let ws;
    let timeout;
    let interval;
    
    // 设置总体超时
    timeout = setTimeout(() => {
      if (ws) ws.close();
      if (interval) clearInterval(interval);
      reject(new Error('语音识别超时'));
    }, WS_TIMEOUT);

    try {
      const wsUrl = getVoiceAuthUrl();
      ws = new WebSocket(wsUrl);
    } catch (err) {
      clearTimeout(timeout);
      return reject(new Error(`WebSocket连接创建失败: ${err.message}`));
    }

    let resultArr = [];

    ws.on('open', () => {
      try {
        const gen = mp3AudioFrameGenerator(audioBuffer);
        const first = gen.next().value;
        
        if (!first) {
          clearTimeout(timeout);
          ws.close();
          return reject(new Error('音频数据为空'));
        }

        ws.send(JSON.stringify({
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
        }));

        interval = setInterval(() => {
          try {
            const next = gen.next();
            if (next.done) {
              clearInterval(interval);
              interval = null;
              return;
            }
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                data: {
                  status: next.value.isLast ? 2 : 1,
                  format: "mp3",
                  encoding: "mp3",
                  audio: next.value.frame.toString('base64')
                }
              }));
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
        console.warn('文本提取失败:', error);
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
          resolve(resultArr.join(''));
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
      reject(new Error(`WebSocket错误: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      console.log(`WebSocket关闭: ${code} - ${reason}`);
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
    
    const buffer = fs.readFileSync(localMp3Path);
    const bitrateKbps = detectMp3Bitrate(buffer);
    const chunks = splitMp3BufferByDuration(buffer, 40, 60, bitrateKbps);
    
    let results = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        console.log(`处理音频块 ${i + 1}/${chunks.length}`);
        const text = await startIatMp3Buffer(chunks[i]);
        results.push(text);
      } catch (e) {
        console.warn(`音频块 ${i + 1} 识别失败:`, e.message);
        results.push('');
      }
    }
    
    return results.join('');
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
  try {
    if (!fs.existsSync(imgPath)) {
      throw new Error(`图像文件不存在: ${imgPath}`);
    }
    
    const stats = fs.statSync(imgPath);
    if (stats.size === 0) {
      throw new Error('图像文件为空');
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
    };
    
    const response = await axios.post(FACE_API_URL, imageBuffer, { 
      headers,
      timeout: REQUEST_TIMEOUT,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`表情分析API错误: ${error.response.status} - ${error.response.data?.message || '未知错误'}`);
    } else if (error.request) {
      throw new Error('表情分析服务无响应，请检查网络连接');
    } else {
      throw new Error(`表情分析失败: ${error.message}`);
    }
  }
}

// ========== 改进的API路由 ==========

// 支持文件上传的原有接口（兼容性保留）
app.post('/api/video/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ 
      success: false,
      error: '未收到视频文件',
      code: 'MISSING_FILE'
    });
  }
  
  await processVideo(req.file.path, res);
});

// 改进的Base64视频数据接口
app.post('/api/video/analyze-base64', async (req, res) => {
  let tempVideoPath = null;
  
  try {
    const { videoData, filename = 'recorded_video.webm' } = req.body;
    
    if (!videoData) {
      return res.status(400).json({ 
        success: false,
        error: '未收到视频数据',
        code: 'MISSING_VIDEO_DATA'
      });
    }
    
    // 验证和清理base64数据
    let base64Data;
    try {
      // 移除可能的data URL前缀
      base64Data = videoData.replace(/^data:video\/[^;]+;base64,/, '');
      
      // 验证base64格式
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) {
        throw new Error('Invalid base64 format');
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: '视频数据格式错误',
        code: 'INVALID_VIDEO_FORMAT'
      });
    }
    
    let videoBuffer;
    try {
      videoBuffer = Buffer.from(base64Data, 'base64');
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Base64解码失败',
        code: 'BASE64_DECODE_ERROR'
      });
    }
    
    if (videoBuffer.length === 0) {
      return res.status(400).json({
        success: false,
        error: '视频数据为空',
        code: 'EMPTY_VIDEO_DATA'
      });
    }
    
    // 验证视频数据的基本结构
    const isValidWebM = videoBuffer.slice(0, 4).toString('hex') === '1a45dfa3';
    const isValidMP4 = videoBuffer.slice(4, 8).toString() === 'ftyp';
    
    if (!isValidWebM && !isValidMP4) {
      console.warn('视频数据可能损坏，但继续处理...');
    }
    
    // 保存临时文件，使用更安全的文件名
    const ext = path.extname(filename) || '.webm';
    const safeFilename = `temp_${Date.now()}_${Math.floor(Math.random()*10000)}${ext}`;
    tempVideoPath = path.join(uploadDir, safeFilename);
    
    try {
      fs.writeFileSync(tempVideoPath, videoBuffer);
      console.log(`临时视频文件已保存: ${tempVideoPath}, 大小: ${videoBuffer.length} bytes`);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: '临时文件保存失败: ' + error.message,
        code: 'FILE_SAVE_ERROR'
      });
    }
    
    await processVideo(tempVideoPath, res);
    
  } catch (error) {
    console.error('Base64视频处理错误:', error);
    
    // 清理临时文件
    if (tempVideoPath && fs.existsSync(tempVideoPath)) {
      try {
        fs.unlinkSync(tempVideoPath);
      } catch (e) {
        console.warn('清理临时文件失败:', e.message);
      }
    }
    
    res.status(500).json({ 
      success: false,
      error: '视频处理失败: ' + error.message,
      code: 'PROCESSING_ERROR'
    });
  }
});

// 改进的通用视频处理函数
async function processVideo(videoPath, res) {
  const startTime = Date.now();
  const framesDir = path.join(uploadDir, `frames_${Date.now()}_${Math.floor(Math.random()*10000)}`);
  const audioMp3Path = path.join(uploadDir, `${Date.now()}_audio.mp3`);

  try {
    console.log('开始处理视频:', videoPath);
    
    // 验证视频文件
    const stats = fs.statSync(videoPath);
    if (stats.size === 0) {
      throw new Error('视频文件为空');
    }
    
    console.log(`视频文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // 验证视频完整性
    console.log('验证视频完整性...');
    let videoInfo;
    try {
      videoInfo = await validateVideoFile(videoPath);
      console.log('视频验证通过:', videoInfo);
    } catch (error) {
      throw new Error(`视频文件验证失败: ${error.message}`);
    }

    // 1. 抽帧
    console.log('开始抽帧...');
    await extractFrames(videoPath, framesDir);
    console.log('抽帧完成');

    // 2. 提取音频（仅当有音频流时）
    let audioPath = null;
    if (videoInfo.hasAudio) {
      console.log('开始提取音频...');
      try {
        await extractAudioMp3(videoPath, audioMp3Path);
        audioPath = audioMp3Path;
        console.log('音频提取完成');
      } catch (error) {
        console.warn('音频提取失败，跳过语音识别:', error.message);
      }
    } else {
      console.log('视频中没有音频流，跳过音频处理');
    }

    // 3. 表情分析
    console.log('开始表情分析...');
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)?.[0] || '0');
        const numB = parseInt(b.match(/\d+/)?.[0] || '0');
        return numA - numB;
      });
    
    console.log(`找到 ${frameFiles.length} 个视频帧`);
    const emotionResults = [];
    
    for (let i = 0; i < frameFiles.length; i++) {
      const frame = frameFiles[i];
      try {
        console.log(`分析第 ${i + 1}/${frameFiles.length} 帧: ${frame}`);
        const imgPath = path.join(framesDir, frame);
        const emotion = await analyzeImageEmotion(imgPath);
        emotionResults.push({ 
          frame, 
          emotion,
          timestamp: i // 添加时间戳信息
        });
      } catch (error) {
        console.warn(`表情分析失败 - 帧: ${frame}`, error.message);
        emotionResults.push({ 
          frame, 
          emotion: { 
            error: error.message,
            code: 'EMOTION_ANALYSIS_FAILED'
          },
          timestamp: i
        });
      }
    }
    
    console.log('表情分析完成');

    // 4. 语音识别
    let asrText = '';
    let asrError = null;
    
    if (audioPath && fs.existsSync(audioPath)) {
      console.log('开始语音识别...');
      try {
        asrText = await recognizeMp3File(audioPath);
        console.log('语音识别完成');
      } catch (error) {
        console.warn('语音识别失败:', error.message);
        asrError = {
          message: error.message,
          code: 'ASR_FAILED'
        };
      }
    } else {
      console.log('跳过语音识别（无音频文件）');
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
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString(),
      videoInfo: {
        ...videoInfo,
        size: stats.size,
        sizeMB: (stats.size / 1024 / 1024).toFixed(2)
      }
    };
    
    console.log(`视频处理完成，耗时: ${processingTime}ms`);
    res.json(result);
    
  } catch (error) {
    console.error('视频处理错误:', error);
    const processingTime = Date.now() - startTime;
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: 'VIDEO_PROCESSING_ERROR',
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString()
    });
  } finally {
    // 延迟清理临时文件，确保响应已发送
    setTimeout(() => {
      try { 
        if (fs.existsSync(videoPath)) {
          fs.unlinkSync(videoPath);
          console.log('临时视频文件已清理:', videoPath);
        }
      } catch (e) { 
        console.warn('清理视频文件失败:', e.message); 
      }
      
      try { 
        if (fs.existsSync(audioMp3Path)) {
          fs.unlinkSync(audioMp3Path);
          console.log('临时音频文件已清理:', audioMp3Path);
        }
      } catch (e) { 
        console.warn('清理音频文件失败:', e.message); 
      }
      
      try { 
        if (fs.existsSync(framesDir)) {
          fs.rmSync(framesDir, { recursive: true, force: true });
          console.log('临时帧文件夹已清理:', framesDir);
        }
      } catch (e) { 
        console.warn('清理帧文件夹失败:', e.message); 
      }
    }, 3000); // 增加延迟时间确保响应完成
  }
}

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
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
    }
  });
});

// 服务器信息接口
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Video Analysis Server',
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    capabilities: {
      videoFormats: ['mp4', 'webm', 'ogg', 'avi', 'mov'],
      maxFileSize: '100MB',
      features: ['emotion-analysis', 'speech-recognition', 'frame-extraction', 'video-validation']
    }
  });
});

// 改进的错误处理中间件
app.use((error, req, res, next) => {
  console.error('服务器错误:', error);
  
  // Multer错误处理
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: '文件太大，最大支持100MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    return res.status(400).json({
      success: false,
      error: '文件上传错误: ' + error.message,
      code: 'UPLOAD_ERROR'
    });
  }
  
  // 通用错误处理
  res.status(500).json({ 
    success: false,
    error: '服务器内部错误',
    code: 'INTERNAL_SERVER_ERROR',
    timestamp: new Date().toISOString()
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在',
    code: 'NOT_FOUND',
    path: req.path
  });
});

const port = process.env.PORT || 3100;
app.listen(port, () => {
  console.log(`=== Video Analysis Server Started ===`);
  console.log(`Server URL: http://localhost:${port}`);
  console.log(`Health Check: http://localhost:${port}/health`);
  console.log(`Server Info: http://localhost:${port}/api/info`);
  console.log(`Upload Directory: ${uploadDir}`);
  console.log(`=== Ready to accept requests ===`);
});

// 优雅关闭处理
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n服务器被终止');
  process.exit(0);
});
