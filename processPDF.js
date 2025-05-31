const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const APP_ID = 'e8f592b9';
const API_SECRET = 'MWMwMDI0MGJkYzY2ZjkyODg5ODg2ZTg4';

const XF_BASE = 'https://chatdoc.xfyun.cn/openapi/v1';
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `[${timestamp}] [${level}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: path.join(LOG_DIR, 'xfyun-chatdoc.log') }),
    new winston.transports.Console()
  ],
});

const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(cors());
app.use(express.json());

// 统计上传到获得总结的用时
let totalSummaryTime = 0;
let summaryCount = 0;

// 请求计时中间件（可选，统计所有请求总耗时）
// let totalTime = 0, requestCount = 0;
// app.use((req, res, next) => {
//   const start = Date.now();
//   res.on('finish', () => {
//     const duration = Date.now() - start;
//     totalTime += duration;
//     requestCount += 1;
//     logger.info(`[STATS] Request ${req.method} ${req.originalUrl} took ${duration}ms`);
//   });
//   next();
// });

function logError(traceId, step, err, extra = {}) {
  logger.error(`[${traceId}] [${step}] ${err.message || err}`, { stack: err.stack, ...extra });
}

function logInfo(traceId, step, msg, extra = {}) {
  logger.info(`[${traceId}] [${step}] ${msg}`, extra);
}

// 修正后的签名算法: MD5 + HMAC-SHA1 + Base64
function generateSignature(appId, apiSecret, timestamp) {
  const rawStr = `${appId}${timestamp}`;
  const md5 = crypto.createHash('md5').update(rawStr).digest('hex');
  const hmac = crypto.createHmac('sha1', apiSecret).update(md5).digest();
  return Buffer.from(hmac).toString('base64');
}

// 上传文件接口
async function uploadFileToXfyun(filepath, filename, traceId) {
  const url = `${XF_BASE}/file/upload`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(APP_ID, API_SECRET, timestamp);

  const form = new FormData();
  form.append('file', fs.createReadStream(filepath), filename);

  const headers = {
    ...form.getHeaders(),
    'appid': APP_ID,
    'timestamp': timestamp,
    'signature': signature
  };

  try {
    logInfo(traceId, 'upload', `Uploading file: ${filename}`, { url, headers });
    const resp = await axios.post(url, form, { headers });
    logInfo(traceId, 'upload', `Upload response:`, { data: resp.data });
    if (resp.data.code !== 0) throw new Error(`上传失败: ${resp.data.desc || resp.data.code}`);
    return resp.data.data.fileId;
  } catch (err) {
    logError(traceId, 'upload', err);
    throw err;
  }
}

// 查询文档状态接口
async function waitForFileReady(fileId, traceId, maxTries = 20) {
  const url = `${XF_BASE}/file/status`;
  for (let i = 0; i < maxTries; i++) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = generateSignature(APP_ID, API_SECRET, timestamp);

    const form = new FormData();
    form.append('fileIds', fileId);

    const headers = {
      ...form.getHeaders(),
      'appid': APP_ID,
      'timestamp': timestamp,
      'signature': signature
    };

    try {
      logInfo(traceId, 'fileStatus', `Checking file status. Try ${i + 1}`, { url, headers });
      const resp = await axios.post(url, form, { headers });
      logInfo(traceId, 'fileStatus', `File status response:`, { data: resp.data });

      if (resp.data.code !== 0) throw new Error(`状态查询失败: ${resp.data.desc || resp.data.code}`);

      const statusArr = resp.data.data || [];
      const statusObj = statusArr.find(x => x.fileId === fileId);
      if (!statusObj) throw new Error(`未找到文件${fileId}状态`);

      const status = statusObj.fileStatus;
      if (['splited', 'vectoring', 'vectored'].includes(status)) return;
    } catch (err) {
      logError(traceId, 'fileStatus', err);
      throw err;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  const timeoutErr = new Error('文件预处理超时，无法总结');
  logError(traceId, 'fileStatus', timeoutErr);
  throw timeoutErr;
}

// 发起文档总结接口
async function startSummary(fileId, traceId) {
  const url = `${XF_BASE}/file/summary/start`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = generateSignature(APP_ID, API_SECRET, timestamp);

  const form = new FormData();
  form.append('fileId', fileId);

  const headers = {
    ...form.getHeaders(),
    'appid': APP_ID,
    'timestamp': timestamp,
    'signature': signature
  };

  try {
    logInfo(traceId, 'summary', `Requesting summary for fileId: ${fileId}`, { url, headers });
    const resp = await axios.post(url, form, { headers });
    logInfo(traceId, 'summary', `Summary start response:`, { data: resp.data });
    if (resp.data.code !== 0) throw new Error(`总结请求失败: ${resp.data.desc || resp.data.code}`);
    return resp.data.sid;
  } catch (err) {
    logError(traceId, 'summary', err);
    throw err;
  }
}

// 轮询获取总结结果接口（修正为 fileId + /file/summary/query）
async function pollSummaryResult(fileId, traceId, maxTries = 25) {
  const url = `${XF_BASE}/file/summary/query`;
  for (let i = 0; i < maxTries; i++) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = generateSignature(APP_ID, API_SECRET, timestamp);

    const form = new FormData();
    form.append('fileId', fileId);

    const headers = {
      ...form.getHeaders(),
      'appid': APP_ID,
      'timestamp': timestamp,
      'signature': signature
    };

    try {
      logInfo(traceId, 'pollSummary', `Polling summary result. Try ${i + 1}`, { url, headers });
      const resp = await axios.post(url, form, { headers });
      logInfo(traceId, 'pollSummary', `Summary poll response:`, { data: resp.data });
      if (resp.data.code === 0 && resp.data.data) {
        const status = resp.data.data.summaryStatus;
        if (status === 'done') {
          return resp.data.data.summary;
        } else if (status === 'failed' || status === 'illegal') {
          throw new Error('总结失败或内容敏感');
        }
        // 其它状态, 继续轮询
      }
    } catch (err) {
      logError(traceId, 'pollSummary', err);
      throw err;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  const timeoutErr = new Error('总结结果获取超时');
  logError(traceId, 'pollSummary', timeoutErr);
  throw timeoutErr;
}

app.post('/api/xfyun/summarize', upload.single('file'), async (req, res) => {
  const traceId = uuidv4();
  const { file } = req;
  if (!file) {
    logError(traceId, 'entry', new Error('文件未上传'));
    return res.status(400).json({ error: '文件未上传', traceId });
  }
  const startTime = Date.now();
  try {
    // 1. 上传文件
    const fileId = await uploadFileToXfyun(file.path, file.originalname, traceId);

    // 2. 等待文件处理完成
    await waitForFileReady(fileId, traceId);

    // 3. 发起文档总结
    await startSummary(fileId, traceId);

    // 4. 轮询获取总结结果
    const summary = await pollSummaryResult(fileId, traceId);

    const costTime = Date.now() - startTime;
    // 更新统计
    totalSummaryTime += costTime;
    summaryCount += 1;
    logInfo(traceId, 'done', `Summary completed, costTime=${costTime} ms`, { fileId, costTime });

    res.json({ summary, fileId, traceId, costTime });
  } catch (err) {
    logError(traceId, 'api', err);
    res.status(500).json({ error: err.message || err, traceId });
  } finally {
    fs.unlink(file.path, () => {});
  }
});

// 查询平均用时接口
app.get('/api/xfyun/avgtime', (req, res) => {
  const avg = summaryCount ? (totalSummaryTime / summaryCount).toFixed(2) : 0;
  res.json({
    summaryCount,
    totalSummaryTime,
    avgTime: Number(avg) // ms
  });
});

app.listen(3000, () => {
  logger.info('xfyun chatdoc backend with logging listening on :3000');
});
