const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const upload = multer();

const API_URL = "http://tupapi.xfyun.cn/v1/expression"; // 科大讯飞表情分析 API 地址
const API_APPID = "e8f592b9"; // 替换为你的 App ID
const API_SECRET = "7a716e2b437bbf31dd9f6ebc07978fe1"; // 替换为你的 API Secret

app.use(bodyParser.json());
app.use(cors());

// 日志记录中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 生成 X-CheckSum 签名
function generateSignature(imageName) {
  const curTime = new Date().toUTCString(); // RFC1123 格式时间戳
  const xParam = Buffer.from(JSON.stringify({ image_name: imageName, image_url: "" })).toString("base64");

  // 签名原始字符串
  const stringToSign = `host: tupapi.xfyun.cn\ndate: ${curTime}\nPOST /v1/expression HTTP/1.1`;
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(stringToSign)
    .digest("base64");

  return { curTime, xParam, signature };
}

// 将图片发送到科大讯飞 API 进行分析
async function sendToAI(imageBuffer, fileName) {
  const { curTime, xParam, signature } = generateSignature(fileName);

  const headers = {
    "X-Appid": API_APPID,
    "X-CurTime": curTime,
    "X-CheckSum": signature,
    "X-Param": xParam,
    "Content-Type": "image/jpeg", // 二进制传图
  };

  try {
    const response = await axios.post(API_URL, imageBuffer, { headers });
    return response.data; // 返回科大讯飞 API 的分析结果
  } catch (error) {
    console.error(`[${new Date().toISOString()}] AI analysis failed:`, error.response ? error.response.data : error.message);
    throw new Error("Failed to process the image with AI service.");
  }
}

// 处理多张图片上传和表情变化分析
app.post("/analyze", upload.single("images"), async (req, res) => {
  try {
    if (!req.file) {
      console.error(`[${new Date().toISOString()}] Error: No image received.`);
      return res.status(400).json({ error: "No image received." });
    }

    console.log(`[${new Date().toISOString()}] 1 image received.`);

    // 发送到科大讯飞AI分析
    const aiResult = await sendToAI(req.file.buffer, req.file.originalname);

    // 返回分析结果
    res.status(200).json({
      success: true,
      message: "Image analyzed successfully.",
      analysisResults: [{
        imageName: req.file.originalname,
        aiResult,
      }],
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Unexpected error:`, error.message);
    res.status(500).json({ error: "Unexpected error occurred." });
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server is running on http://localhost:${PORT}`);
});