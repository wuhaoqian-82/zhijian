const crypto = require('crypto');

// 修复时间戳生成函数
function getFormattedDate() {
  const date = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  return `${days[date.getUTCDay()]}, ${date.getUTCDate().toString().padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${date.getUTCHours().toString().padStart(2, '0')}:${date.getUTCMinutes().toString().padStart(2, '0')}:${date.getUTCSeconds().toString().padStart(2, '0')} GMT`;
}

// 修复签名函数
function signHMACSHA256(secret, message) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(message);
  return hmac.digest('base64');
}

// 生成鉴权URL（星火API v4.0Ultra）
function generateAuthUrl(apiKey, apiSecret) {
  const date = getFormattedDate();
  
  // 创建签名字符串
  const signatureStr = `host: spark-api.xf-yun.com\ndate: ${date}\nGET /v4.0/chat HTTP/1.1`;
  
  // 生成签名
  const signature = signHMACSHA256(apiSecret, signatureStr);
  
  // 生成authorization header
  const authorization = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  
  // URL编码
  const encodedAuth = Buffer.from(authorization).toString('base64');
  
  // 生成最终URL
  const params = new URLSearchParams({
    authorization: encodedAuth,
    date,
    host: "spark-api.xf-yun.com"
  });
  
  return `wss://spark-api.xf-yun.com/v4.0/chat?${params.toString()}`;
}

// 导出生成函数
module.exports = { generateAuthUrl };