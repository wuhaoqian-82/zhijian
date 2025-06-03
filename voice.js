const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const mp3Parser = require('mp3-parser');

// ===== 1. 配置信息（请替换为你的实际信息） =====
const APPID = 'e8f592b9';       // 替换为你的APPID
const APIKey = 'e22b24049f00d5729427119b825f4a71';     // 替换为你的APIKey
const APISecret = 'MWMwMDI0MGJkYzY2ZjkyODg5ODg2ZTg4'; // 替换为你的APISecret

// ===== 2. 日志辅助 =====
function logError(msg, err) {
  const time = new Date().toISOString();
  console.error(`[${time}] 错误: ${msg}`);
  if (err) {
    if (err instanceof Error) {
      console.error(err.stack || err);
    } else {
      console.error(err);
    }
  }
}

// ===== 3. 生成鉴权参数 =====
function getAuthUrl() {
  try {
    const host = "iat-api.xfyun.cn";
    const date = new Date().toUTCString();
    const requestLine = "GET /v2/iat HTTP/1.1";
    const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
    const signatureSha = crypto
      .createHmac('sha256', APISecret)
      .update(signatureOrigin)
      .digest('base64');

    const authorizationOrigin = `api_key="${APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signatureSha}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');

    const wsUrl = `wss://${host}/v2/iat?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${host}`;
    return wsUrl;
  } catch (err) {
    logError('生成鉴权参数失败', err);
    throw err;
  }
}

// ===== 4. 按40ms一帧切片MP3音频 =====
const FRAME_INTERVAL = 40; // ms
const MP3_FRAME_SIZE = 8192; // 8KB 每帧

function* mp3AudioFrameGenerator(buffer, frameSize = MP3_FRAME_SIZE) {
  let offset = 0;
  while (offset < buffer.length) {
    const end = Math.min(offset + frameSize, buffer.length);
    const frame = buffer.slice(offset, end);
    const isLast = end === buffer.length;
    yield { frame, isLast };
    offset = end;
  }
}

// ===== 5. WebSocket 通信及数据发送（支持动态修正） =====
function startIatMp3Buffer(audioBuffer) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      const wsUrl = getAuthUrl();
      ws = new WebSocket(wsUrl);
    } catch (err) {
      logError('WebSocket初始化失败', err);
      return reject(err);
    }
    let resultArr = [];

    ws.on('open', () => {
      try {
        const gen = mp3AudioFrameGenerator(audioBuffer);

        // 发送首帧
        const first = gen.next().value;
        ws.send(JSON.stringify({
          common: {app_id: APPID},
          business: {
            language: "zh_cn",
            domain: "iat",
            accent: "mandarin",
            dwa: "wpgs", // 动态修正开启
            nbest: 1
          },
          data: {
            status: 0,
            format: "mp3",
            encoding: "mp3",
            audio: first.frame.toString('base64')
          }
        }));

        // 发送中间帧/尾帧
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
            logError('发送音频帧出错', err);
            clearInterval(interval);
            ws.close();
            reject(err);
          }
        }, FRAME_INTERVAL);
      } catch (err) {
        logError('发送音频数据失败', err);
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
          logError(`讯飞接口错误 code=${res.code} msg=${res.message}`, res);
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
        logError('处理返回消息失败', err);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      logError('WebSocket错误', err);
      reject(err);
    });
    ws.on('close', (code, reason) => {
      if (code !== 1000) {
        logError(`WebSocket被异常关闭 code=${code} reason=${reason}`);
      }
    });
  });
}

// ===== 6. 自动检测MP3码率 =====
function detectMp3Bitrate(buffer) {
  try {
    const len = Math.min(buffer.length, 1024 * 1024);
    let idx = 0;
    while (idx < len - 4) {
      if (buffer[idx] === 0xFF && (buffer[idx + 1] & 0xE0) === 0xE0) {
        try {
          const frame = mp3Parser.readFrameHeader(buffer, idx);
          if (frame && frame.bitrate) {
            return Math.round(frame.bitrate / 1000); // kbps
          }
        } catch (e) {
          // 跳过不合法帧
        }
      }
      idx++;
    }
    return 128;
  } catch (err) {
    logError('检测MP3码率失败', err);
    return 128;
  }
}

// ===== 7. 自动分段，保证每段40~60秒 =====
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
  } catch (err) {
    logError('切分音频失败', err);
    throw err;
  }
}

// ===== 8. 主识别方法，接收本地mp3路径，返回识别文本 =====
/**
 * 本地mp3文件路径 => 识别文本
 * @param {string} localMp3Path
 * @returns {Promise<string>}
 */
async function recognizeMp3File(localMp3Path) {
  try {
    if (!fs.existsSync(localMp3Path)) {
      const errMsg = '文件不存在: ' + localMp3Path;
      logError(errMsg);
      throw new Error(errMsg);
    }
    const ext = path.extname(localMp3Path).toLowerCase();
    if (ext !== '.mp3') {
      const errMsg = '仅支持mp3文件！';
      logError(errMsg);
      throw new Error(errMsg);
    }
    const buffer = fs.readFileSync(localMp3Path);
    const bitrateKbps = detectMp3Bitrate(buffer);
    console.log(`[INFO] 检测到码率：${bitrateKbps} kbps`);
    const chunks = splitMp3BufferByDuration(buffer, 40, 60, bitrateKbps);
    let results = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[INFO] 正在识别第${i + 1}/${chunks.length}段...`);
      try {
        const text = await startIatMp3Buffer(chunks[i]);
        results.push(text);
      } catch (e) {
        logError(`第${i + 1}段识别失败`, e);
        results.push('');
      }
    }
    const finalText = results.join('');
    return finalText;
  } catch (err) {
    logError('recognizeMp3File异常', err);
    throw err;
  }
}

// ===== 9. Express文件上传与前端适配接口 =====
const express = require('express');
const multer = require('multer');
const os = require('os');

// 上传目录
const uploadDir = path.join(os.tmpdir(), 'mp3upload');
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
const upload = multer({
  storage,
  fileFilter: function (req, file, cb) {
    if (file.mimetype === 'audio/mpeg' || path.extname(file.originalname).toLowerCase() === '.mp3') {
      cb(null, true);
    } else {
      cb(new Error('仅支持mp3文件上传'), false);
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }
});

const app = express();
const port = 3000;

// 允许跨域（如需）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// 前端适配接口：/api/iat
app.post('/api/iat', upload.single('file'), async (req, res) => {
  if (!req.file) {
    logError('未收到文件');
    return res.status(400).json({ error: '未接收到文件，请上传mp3文件' });
  }
  try {
    const filePath = req.file.path;
    const text = await recognizeMp3File(filePath);
    res.json({ text });
  } catch (err) {
    logError('识别API处理异常', err);
    res.status(500).json({ error: err.message });
  } finally {
    // 自动删除临时文件
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (e) => { if (e) logError('删除临时文件失败', e); });
    }
  }
});

// 可选：静态目录用于前端页面本地测试
app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// ===== 10. 导出方法（如需供其他代码调用）=====
module.exports = recognizeMp3File;