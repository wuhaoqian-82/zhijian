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

// ========== 配置 ==========

// 讯飞语音识别API
const VOICE_APPID = 'e8f592b9';
const VOICE_APIKey = 'e22b24049f00d5729427119b825f4a71';
const VOICE_APISecret = 'MWMwMDI0MGJkYzY2ZjkyODg5ODg2ZTg4';

// 讯飞表情API
const FACE_API_URL = "http://tupapi.xfyun.cn/v1/expression";
const FACE_APPID = "e8f592b9";
const FACE_SECRET = "7a716e2b437bbf31dd9f6ebc07978fe1";

// ========== Express/Multer ==========
const app = express();
const uploadDir = path.join(os.tmpdir(), 'video_analyze');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, basename + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// ========== 工具函数 ==========

// ---- ffmpeg-static + fluent-ffmpeg ----
ffmpeg.setFfmpegPath(ffmpegPath);

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

// ---- 讯飞语音识别实现 ----
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
  if (path.extname(localMp3Path).toLowerCase() !== '.mp3') throw new Error('仅支持mp3文件！');
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

// ---- 讯飞表情分析实现 ----
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

// ========== 主API ==========

app.post('/api/video/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到视频文件' });
  }
  const videoPath = req.file.path;
  const framesDir = path.join(uploadDir, `frames_${Date.now()}_${Math.floor(Math.random()*10000)}`);
  const audioMp3Path = path.join(uploadDir, `${Date.now()}_audio.mp3`);

  try {
    // 1. 抽帧
    await extractFrames(videoPath, framesDir);

    // 2. 音频
    await extractAudioMp3(videoPath, audioMp3Path);

    // 3. 表情分析
    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const emotionResults = [];
    for (const frame of frameFiles) {
      const imgPath = path.join(framesDir, frame);
      const emotion = await analyzeImageEmotion(imgPath);
      emotionResults.push({ frame, emotion });
    }

    // 4. 音频识别
    const asrText = await recognizeMp3File(audioMp3Path);

    // 5. 返回
    res.json({
      emotionTimeline: emotionResults,
      asrText
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioMp3Path); } catch {}
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
  }
});

const port = 3100;
app.listen(port, () => {
  console.log(`Video analyze server running on http://localhost:${port}`);
});
