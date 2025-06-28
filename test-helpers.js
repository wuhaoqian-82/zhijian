const fs = require('fs');
const path = require('path');

/**
 * 生成测试用的模拟视频
 * @param {string} outputPath - 输出路径
 * @param {number} durationSecs - 视频时长(秒)
 * @returns {Promise<string>} - 视频文件路径
 */
async function createMockVideo(outputPath, durationSecs = 5) {
  // 在这里实现实际逻辑生成测试视频
  // 对于单元测试，我们可以简单创建一个空文件
  const videoBuffer = Buffer.alloc(1024 * 1024); // 1MB空文件
  fs.writeFileSync(outputPath, videoBuffer);
  return outputPath;
}

/**
 * 生成测试用的模拟音频
 * @param {string} outputPath - 输出路径
 * @returns {Promise<string>} - 音频文件路径
 */
async function createMockAudio(outputPath) {
  // 创建模拟MP3文件
  const audioBuffer = Buffer.alloc(1024 * 100);
  fs.writeFileSync(outputPath, audioBuffer);
  return outputPath;
}

/**
 * 生成测试用的模拟图片
 * @param {string} outputPath - 输出路径
 * @returns {Promise<string>} - 图片文件路径
 */
async function createMockImage(outputPath) {
  // 创建模拟JPG文件
  const imageBuffer = Buffer.alloc(1024 * 50);
  fs.writeFileSync(outputPath, imageBuffer);
  return outputPath;
}

module.exports = {
  createMockVideo,
  createMockAudio,
  createMockImage
};