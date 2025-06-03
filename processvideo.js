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
const mp3Parser = require("mp3-parser");

// ========== 环境变量配置 ==========
const VOICE_APPID = process.env.VOICE_APPID || 'e8f592b9';
const VOICE_APIKey = process.env.VOICE_API_KEY || 'e22b24049f00d5729427119b825f4a71';
const VOICE_APISecret = process.env.VOICE_API_SECRET || 'MWMwMDI0MGJkYzY2ZjkyODg5ODg2ZTg4';

const FACE_API_URL = "http://tupapi.xfyun.cn/v1/expression";
const FACE_APPID = process.env.FACE_APPID || "e8f592b9";
const FACE_SECRET = process.env.FACE_SECRET || "7a716e2b437bbf31dd9f6ebc07978fe1";

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
    const ext = path.extname(file.originalname) || '.webm'; // 摄像头录制通常是webm格式
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
      'video/webm',  // 摄像头录制常用格式
      'video/ogg',   // 部分浏览器支持
      'video/avi', 
      'video/mov'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式'));
    }
  }
});

app.use(express.json({ limit: '50mb' })); // 支持大文件的base64传输
app.use(express.raw({ type: 'video/*', limit: '100mb' })); // 支持直接视频数据传输

// CORS 配置优化
app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:5500' // Live Server默认端口
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ========== ffmpeg配置 ==========
ffmpeg.setFfmpegPath(ffmpegPath);

// ========== 工具函数 ==========

function extractFrames(videoPath, framesDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(framesDir, { recursive: true });
    ffmpeg(videoPath)
      .output(path.join(framesDir, 'frame_%04d.jpg'))
      .outputOptions(['-vf', 'fps=1']) // 每秒1帧
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function extractAudioMp3(videoPath, audioMp3Path) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioMp3Path)
      .audioCodec('libmp3lame')
      .audioFrequency(16000)
      .audioChannels(1)
      .audioBitrate('96k')
      .noVideo()
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// 讯飞语音识别相关函数
function getVoiceAuthUrl() {
  const host = "iat-api.xfyun.cn";
  const date = new Date().toUTCString();
  const requestLine = "GET /v2/iat HTTP/1.1";
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signatureSha = crypto.createHmac('sha256', VOICE_APISecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${VOICE_APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${host}/v2/iat?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
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
  const len = Math.min(buffer.length, 1024 * 1024);
  let idx = 0;
  while (idx < len - 4) {
    if (buffer[idx] === 0xFF && (buffer[idx + 1] & 0xE0) === 0xE0) {
      try {
        const frame = mp3Parser.readFrameHeader(buffer, idx);
        if (frame && frame.bitrate) {
          return Math.round(frame.bitrate / 1000);
        }
      } catch (e) {}
    }
    idx++;
  }
  return 128;
}

function splitMp3BufferByDuration(buffer, minSeconds = 40, maxSeconds = 60, bitrateKbps = 128) {
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
}

function startIatMp3Buffer(audioBuffer) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      const wsUrl = getVoiceAuthUrl();
      ws = new WebSocket(wsUrl);
    } catch (err) {
      return reject(err);
    }
    let resultArr = [];

    ws.on('open', () => {
      try {
        const gen = mp3AudioFrameGenerator(audioBuffer);
        const first = gen.next().value;
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

        let interval = setInterval(() => {
          try {
            const next = gen.next();
            if (next.done) {
              clearInterval(interval);
              return;
            }
            ws.send(JSON.stringify({
              data: {
                status: next.value.isLast ? 2 : 1,
                format: "mp3",
                encoding: "mp3",
                audio: next.value.frame.toString('base64')
              }
            }));
            if (next.value.isLast) clearInterval(interval);
          } catch (err) {
            clearInterval(interval);
            ws.close();
            reject(err);
          }
        }, 40);
      } catch (err) {
        ws.close();
        reject(err);
      }
    });

    function getText(wsArr) {
      return wsArr.map(item => item.cw.map(cw => cw.w).join('')).join('');
    }

    ws.on('message', (data) => {
      try {
        const res = JSON.parse(data);
        if (res.code !== 0) {
          ws.close();
          reject(res.message || '接口错误');
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
          ws.close();
          resolve(resultArr.join(''));
        }
      } catch (err) {
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => reject(err));
    ws.on('close', (code, reason) => {});
  });
}

async function recognizeMp3File(localMp3Path) {
  if (!fs.existsSync(localMp3Path)) throw new Error('文件不存在: ' + localMp3Path);
  const buffer = fs.readFileSync(localMp3Path);
  const bitrateKbps = detectMp3Bitrate(buffer);
  const chunks = splitMp3BufferByDuration(buffer, 40, 60, bitrateKbps);
  let results = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const text = await startIatMp3Buffer(chunks[i]);
      results.push(text);
    } catch (e) {
      results.push('');
    }
  }
  return results.join('');
}

// 讯飞表情分析相关函数
function generateFaceSignature(imageName) {
  const curTime = new Date().toUTCString();
  const xParam = Buffer.from(JSON.stringify({ image_name: imageName, image_url: "" })).toString("base64");
  const stringToSign = `host: tupapi.xfyun.cn\ndate: ${curTime}\nPOST /v1/expression HTTP/1.1`;
  const signature = crypto.createHmac("sha256", FACE_SECRET).update(stringToSign).digest("base64");
  return { curTime, xParam, signature };
}

async function analyzeImageEmotion(imgPath) {
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
  try {
    const response = await axios.post(FACE_API_URL, imageBuffer, { headers });
    return response.data;
  } catch (error) {
    throw new Error("Failed to process the image with AI service.");
  }
}

// ========== API路由 ==========

// 支持文件上传的原有接口（兼容性保留）
app.post('/api/video/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到视频文件' });
  }
  
  await processVideo(req.file.path, res);
});

// 新增：支持Base64视频数据的接口（适合摄像头录制）
app.post('/api/video/analyze-base64', async (req, res) => {
  try {
    const { videoData, filename = 'recorded_video.webm' } = req.body;
    
    if (!videoData) {
      return res.status(400).json({ error: '未收到视频数据' });
    }
    
    // 移除data URL前缀（如果存在）
    const base64Data = videoData.replace(/^data:video\/[a-z]+;base64,/, '');
    const videoBuffer = Buffer.from(base64Data, 'base64');
    
    // 保存临时文件
    const ext = path.extname(filename) || '.webm';
    const tempVideoPath = path.join(uploadDir, `temp_${Date.now()}_${Math.floor(Math.random()*10000)}${ext}`);
    fs.writeFileSync(tempVideoPath, videoBuffer);
    
    await processVideo(tempVideoPath, res);
  } catch (error) {
    console.error('Base64视频处理错误:', error);
    res.status(500).json({ error: '视频处理失败: ' + error.message });
  }
});

// 通用视频处理函数
async function processVideo(videoPath, res) {
  const framesDir = path.join(uploadDir, `frames_${Date.now()}_${Math.floor(Math.random()*10000)}`);
  const audioMp3Path = path.join(uploadDir, `${Date.now()}_audio.mp3`);

  try {
    // 1. 抽帧
    console.log('开始抽帧...');
    await extractFrames(videoPath, framesDir);

    // 2. 提取音频
    console.log('开始提取音频...');
    await extractAudioMp3(videoPath, audioMp3Path);

    // 3. 表情分析
    console.log('开始表情分析...');
    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const emotionResults = [];
    
    for (const frame of frameFiles) {
      try {
        const imgPath = path.join(framesDir, frame);
        const emotion = await analyzeImageEmotion(imgPath);
        emotionResults.push({ frame, emotion });
      } catch (error) {
        console.warn(`表情分析失败 - 帧: ${frame}`, error.message);
        emotionResults.push({ frame, emotion: { error: '分析失败' } });
      }
    }

    // 4. 语音识别
    console.log('开始语音识别...');
    let asrText = '';
    try {
      asrText = await recognizeMp3File(audioMp3Path);
    } catch (error) {
      console.warn('语音识别失败:', error.message);
      asrText = '语音识别失败';
    }

    // 5. 返回结果
    res.json({
      success: true,
      emotionTimeline: emotionResults,
      asrText,
      processedFrames: frameFiles.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('视频处理错误:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    // 清理临时文件
    setTimeout(() => {
      try { fs.unlinkSync(videoPath); } catch {}
      try { fs.unlinkSync(audioMp3Path); } catch {}
      try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
    }, 1000); // 延迟清理，确保响应已发送
  }
}

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 错误处理中间件
app.use((error, req, res, next) => {
  console.error('服务器错误:', error);
  res.status(500).json({ 
    error: '服务器内部错误',
    timestamp: new Date().toISOString()
  });
});

const port = process.env.PORT || 3100;
app.listen(port, () => {
  console.log(`Video analyze server running on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});
