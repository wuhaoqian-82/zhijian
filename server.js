// 创建新文件: src/main/forvideo/server.js
const app = require('./processvideo');

const port = process.env.PORT || 3100;
const server = app.listen(port, () => {
  console.log(`=== Video Analysis Server Started (URL-only Mode) ===`);
  console.log(`Server URL: http://localhost:${port}`);
  console.log(`Health Check: http://localhost:${port}/health`);
  console.log(`Server Info: http://localhost:${port}/api/info`);
  console.log(`Video Analysis: http://localhost:${port}/api/video/analyze`);
  console.log(`Upload Directory: ${app.get('uploadDir')}`);
  console.log(`Process ID: ${process.pid}`);
  console.log(`Node Version: ${process.version}`);
  console.log(`Input Method: URL-only`);
  console.log(`=== Ready to accept requests ===`);
});

// 优雅关闭
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
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));