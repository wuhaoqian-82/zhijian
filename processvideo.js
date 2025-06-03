const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
// 保证 fluent-ffmpeg 能找到 ffmpeg 可执行文件
ffmpeg.setFfmpegPath(ffmpegPath);

// 引入 voice.js 的音频处理方法（保留其全部功能）
const recognizeMp3File = require('./voice');

/**
 * 提取视频中的音频和视频流
 * @param {string} videoPath 视频文件路径
 * @returns {Promise<{audio: string, video: string}>}
 */
function extractAudioAndVideo(videoPath) {
  const outputDir = path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioOutputPath = path.join(outputDir, `${baseName}_extracted_audio.mp3`);
  const videoOutputPath = path.join(outputDir, `${baseName}_extracted_video.mp4`);

  // 提取音频
  const audioPromise = new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('mp3')
      .output(audioOutputPath)
      .on('end', () => {
        resolve(audioOutputPath);
      })
      .on('error', (err) => {
        reject(new Error(`提取音频时出错: ${err.message}`));
      })
      .run();
  });

  // 提取视频
  const videoPromise = new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noAudio()
      .output(videoOutputPath)
      .on('end', () => {
        resolve(videoOutputPath);
      })
      .on('error', (err) => {
        reject(new Error(`提取视频时出错: ${err.message}`));
      })
      .run();
  });

  return Promise.all([audioPromise, videoPromise]).then(([audio, video]) => ({ audio, video }));
}

/**
 * 主流程：提取音频、视频，对音频调用 voice.js 处理
 */
async function processVideo(videoPath) {
  try {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`文件不存在：${videoPath}`);
    }
    console.log(`正在处理视频文件：${videoPath}`);

    const { audio, video } = await extractAudioAndVideo(videoPath);
    console.log(`音频已提取: ${audio}`);
    console.log(`视频已提取: ${video}`);

    // 对音频采用 voice.js 保留全部功能的处理
    console.log('正在对音频进行识别处理...');
    const recognizedText = await recognizeMp3File(audio);
    console.log('识别结果如下：');
    console.log(recognizedText);

  } catch (error) {
    console.error("处理视频时发生错误:", error.message || error);
  }
}

// 从命令行参数获取视频文件路径
if (process.argv.length < 3) {
  console.error("使用方法：node processVideo.js <video_file_path>");
  process.exit(1);
}

const videoFilePath = process.argv[2];
processVideo(videoFilePath);