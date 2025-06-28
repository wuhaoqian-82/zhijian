const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
const nock = require('nock');
const supertest = require('supertest');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const existsSync = fs.existsSync;
const readFileSync = fs.readFileSync;
const rewire = require('rewire');

// 导入主应用
const app = rewire('../processvideo');
const { Logger, ResourceManager, ErrorHandler } = require('../processvideo');

// 创建API测试客户端
const request = supertest(app);
// 初始化部分添加
let server;
before(function() {
  // 这里不需要启动服务器，supertest会为每个请求自动启动
  // 只需要确保这里不会导入服务器启动代码
});

after(function() {
  // 确保测试后清理资源
  if (server) {
    server.close();
  }
});
describe('模拟面试视频分析系统测试', function() {
  // 测试可能需要较长时间
  this.timeout(30000);
  
  let sandbox;
  let mockVideoBuffer;
  let mockAudioBuffer;
  let mockImageBuffer;
  
  before(async () => {
    // 加载测试资源
    try {
      const testResourcesDir = path.join(__dirname, 'resources');
      
      // 如果测试资源目录不存在则创建
      if (!existsSync(testResourcesDir)) {
        fs.mkdirSync(testResourcesDir, { recursive: true });
      }
      
      // 准备测试视频，如果不存在则创建一个模拟视频文件
      const mockVideoPath = path.join(testResourcesDir, 'mock_interview.mp4');
      if (!existsSync(mockVideoPath)) {
        console.log('创建测试用模拟视频文件...');
        // 创建一个空白的MP4文件用于测试 (实际测试需要有一个真实的短视频)
        fs.writeFileSync(mockVideoPath, Buffer.alloc(1024 * 1024)); // 1MB空文件
      }
      
      // 加载测试资源
      mockVideoBuffer = readFileSync(path.join(testResourcesDir, 'mock_interview.mp4'));
      
      // 准备测试音频和图像用于模拟
      mockAudioBuffer = Buffer.alloc(1024 * 100); // 模拟音频数据
      mockImageBuffer = Buffer.alloc(1024 * 50);  // 模拟图像数据
      
      console.log('测试资源准备完成');
    } catch (error) {
      console.error('准备测试资源失败:', error);
      throw error;
    }
  });
  
  beforeEach(() => {
    // 创建沙盒以便在每个测试后恢复所有存根和模拟
    sandbox = sinon.createSandbox();
    
    // 禁用网络请求，所有网络请求都需要模拟
    nock.disableNetConnect();
    // 允许对localhost的请求（用于supertest）
    nock.enableNetConnect('127.0.0.1');
  });
  
  afterEach(() => {
    // 清理沙盒
    sandbox.restore();
    // 清理网络模拟
    nock.cleanAll();
    // 恢复网络连接
    nock.enableNetConnect();
  });
  
  describe('1. 基础系统组件测试', () => {
    it('应该正确创建日志', () => {
      const logger = new Logger();
      expect(logger).to.have.property('info').that.is.a('function');
      expect(logger).to.have.property('warn').that.is.a('function');
      expect(logger).to.have.property('error').that.is.a('function');
      expect(logger).to.have.property('debug').that.is.a('function');
    });
    
    it('应该正确管理资源', () => {
      const resourceManager = new ResourceManager();
      expect(resourceManager).to.have.property('registerTempFile').that.is.a('function');
      expect(resourceManager).to.have.property('registerTempDir').that.is.a('function');
      expect(resourceManager).to.have.property('cleanupImmediate').that.is.a('function');
      expect(resourceManager).to.have.property('getStats').that.is.a('function');
    });
    
    it('应该正确处理错误', () => {
      const error = new Error('测试错误');
      const response = ErrorHandler.handle(error);
      expect(response).to.have.property('status').that.is.a('number');
      expect(response).to.have.property('code').that.is.a('string');
      expect(response).to.have.property('message').that.is.a('string');
    });
  });
  
  describe('2. 视频下载和验证测试', () => {
    it('应该正确从URL下载视频', async () => {
      // 模拟视频URL
      const mockVideoUrl = 'https://example.com/mock_interview.mp4';
      
      // 模拟HTTP响应
      nock('https://example.com')
        .get('/mock_interview.mp4')
        .reply(200, mockVideoBuffer, { 
          'Content-Type': 'video/mp4',
          'Content-Length': mockVideoBuffer.length
        });
      
      // 替换文件系统操作
      const writeFileStreamMock = {
        on: sandbox.stub(),
        destroy: sandbox.spy()
      };
      
      // 模拟事件注册
      writeFileStreamMock.on.withArgs('finish').yields();
      
      // 模拟文件写入流
      sandbox.stub(fs, 'createWriteStream').returns(writeFileStreamMock);
      
      // 模拟文件统计
      sandbox.stub(fs, 'statSync').returns({
        size: mockVideoBuffer.length
      });
      
      // 模拟视频下载函数（直接从processvideo.js导出）
      const downloadVideoFromUrl = app.__get__('downloadVideoFromUrl');
      
      // 执行测试
      const result = await downloadVideoFromUrl(mockVideoUrl, 'test_video', '12345');
      
      // 验证结果
      expect(result).to.be.a('string');
      expect(result).to.include('test_video');
      expect(fs.createWriteStream.calledOnce).to.be.true;
    });
    
    it('应该验证视频文件完整性', async () => {
      // 模拟ffprobe返回的元数据
      const mockMetadata = {
        streams: [
          {
            codec_type: 'video',
            width: 640,
            height: 480,
            duration: '300.45'
          },
          {
            codec_type: 'audio',
            sample_rate: '44100',
            duration: '300.45'
          }
        ],
        format: {
          duration: '300.45',
          bit_rate: '500000',
          size: '15000000'
        }
      };
      
      // 模拟ffmpeg的ffprobe功能
      sandbox.stub(require('fluent-ffmpeg'), 'ffprobe').callsFake((path, callback) => {
        callback(null, mockMetadata);
      });
      
      // 获取视频验证函数
      const validateVideoFileStream = app.__get__('validateVideoFileStream');
      
      // 执行测试
      const result = await validateVideoFileStream('/mock/path/video.mp4');
      
      // 验证结果
      expect(result).to.have.property('duration').that.equals(300.45);
      expect(result).to.have.property('hasVideo').that.equals(true);
      expect(result).to.have.property('hasAudio').that.equals(true);
      expect(result).to.have.property('videoCodec');
      expect(result).to.have.property('size');
    });
  });
  
  describe('3. 音频提取和处理测试', () => {
    it('应该从视频中提取音频', async () => {
      // 模拟ffmpeg对象
      const ffmpegMock = {
        output: sandbox.stub().returnsThis(),
        audioCodec: sandbox.stub().returnsThis(),
        audioFrequency: sandbox.stub().returnsThis(),
        audioChannels: sandbox.stub().returnsThis(),
        audioBitrate: sandbox.stub().returnsThis(),
        noVideo: sandbox.stub().returnsThis(),
        outputOptions: sandbox.stub().returnsThis(),
        on: sandbox.stub().returnsThis(),
        run: sandbox.stub()
      };
      
      // 模拟ffmpeg事件
      ffmpegMock.on.withArgs('end').yields();
      
      // 模拟ffmpeg库
      sandbox.stub(require('fluent-ffmpeg')).returns(ffmpegMock);
      
      // 模拟文件检查
      sandbox.stub(fs, 'existsSync').returns(true);
      sandbox.stub(fs, 'statSync').returns({ size: 1024 * 1024 });
      
      // 获取音频提取函数
      const extractAudioOptimized = app.__get__('extractAudioOptimized');
      
      // 执行测试
      await extractAudioOptimized('/mock/path/video.mp4', '/mock/path/audio.mp3');
      
      // 验证结果
      expect(ffmpegMock.output.calledWith('/mock/path/audio.mp3')).to.be.true;
      expect(ffmpegMock.audioCodec.calledWith('libmp3lame')).to.be.true;
      expect(ffmpegMock.run.calledOnce).to.be.true;
    });
    
    it('应该处理MP3音频buffer并进行语音识别', async () => {
      // 模拟WebSocket
      const mockWebSocket = {
        on: sandbox.stub(),
        send: sandbox.spy(),
        close: sandbox.spy(),
        readyState: 1 // OPEN
      };
      
      // 模拟WebSocket事件
      mockWebSocket.on.withArgs('open').yields();
      mockWebSocket.on.withArgs('message').yields(JSON.stringify({
        code: 0,
        data: {
          result: {
            ws: [{ cw: [{ w: '你好' }] }],
            pgs: 'apd'
          },
          status: 2
        }
      }));
      
      // 模拟WebSocket构造函数
      sandbox.stub(global, 'WebSocket').returns(mockWebSocket);
      
      // 模拟认证URL生成
      sandbox.stub(app.__get__('getVoiceAuthUrl')).returns('wss://mock-api.com');
      
      // 获取语音识别函数
      const startIatMp3Buffer = app.__get__('startIatMp3Buffer');
      
      // 执行测试
      const result = await startIatMp3Buffer(mockAudioBuffer);
      
      // 验证结果
      expect(result).to.equal('你好');
      expect(mockWebSocket.send.calledOnce).to.be.true;
      expect(mockWebSocket.close.calledOnce).to.be.true;
    });
  });
  
  describe('4. 视频帧提取和表情分析测试', () => {
    it('应该提取视频帧', async () => {
      // 模拟ffmpeg对象
      const ffmpegMock = {
        output: sandbox.stub().returnsThis(),
        outputOptions: sandbox.stub().returnsThis(),
        on: sandbox.stub().returnsThis(),
        run: sandbox.stub()
      };
      
      // 模拟ffmpeg事件
      ffmpegMock.on.withArgs('end').yields();
      
      // 模拟ffmpeg库
      sandbox.stub(require('fluent-ffmpeg')).returns(ffmpegMock);
      
      // 模拟文件系统操作
      sandbox.stub(fs, 'mkdirSync').returns();
      sandbox.stub(fs, 'readdirSync').returns(['frame_0001.jpg', 'frame_0002.jpg', 'frame_0003.jpg']);
      
      // 获取帧提取函数
      const extractFramesOptimized = app.__get__('extractFramesOptimized');
      
      // 执行测试
      const result = await extractFramesOptimized('/mock/path/video.mp4', '/mock/path/frames');
      
      // 验证结果
      expect(result).to.equal(3);
      expect(ffmpegMock.output.calledWith(path.join('/mock/path/frames', 'frame_%04d.jpg'))).to.be.true;
      expect(ffmpegMock.run.calledOnce).to.be.true;
    });
    
    it('应该分析图像表情', async () => {
      // 模拟API响应
      const mockEmotionResponse = {
        code: 0,
        data: {
          expression: {
            type: 'happy',
            score: 0.95
          }
        }
      };
      
      // 模拟axios请求
      sandbox.stub(require('axios'), 'post').resolves({
        status: 200,
        data: mockEmotionResponse
      });
      
      // 模拟文件操作
      sandbox.stub(fs, 'existsSync').returns(true);
      sandbox.stub(fs, 'statSync').returns({ size: 50 * 1024 });
      sandbox.stub(fs, 'readFileSync').returns(mockImageBuffer);
      
      // 模拟签名函数
      sandbox.stub(app.__get__('generateFaceSignature')).returns({
        curTime: 'mock-time',
        xParam: 'mock-param',
        signature: 'mock-signature'
      });
      
      // 获取表情分析函数
      const analyzeImageEmotion = app.__get__('analyzeImageEmotion');
      
      // 执行测试
      const result = await analyzeImageEmotion('/mock/path/frame_0001.jpg');
      
      // 验证结果
      expect(result).to.deep.equal(mockEmotionResponse);
      expect(require('axios').post.calledOnce).to.be.true;
    });
  });
  
  describe('5. AI综合分析测试', () => {
    it('应该使用大模型进行综合分析', async () => {
      // 模拟WebSocket
      const mockWebSocket = {
        on: sandbox.stub(),
        send: sandbox.spy(),
        close: sandbox.spy(),
        readyState: 1 // OPEN
      };
      
      // 模拟WebSocket事件
      mockWebSocket.on.withArgs('open').yields();
      mockWebSocket.on.withArgs('message').yields(JSON.stringify({
        header: {
          code: 0,
          status: 2
        },
        payload: {
          choices: {
            text: [{
              content: '这是面试分析结果'
            }]
          }
        }
      }));
      
      // 模拟WebSocket构造函数
      sandbox.stub(global, 'WebSocket').returns(mockWebSocket);
      
      // 模拟认证URL生成
      sandbox.stub(app.__get__('generateAuthUrl')).returns('wss://mock-llm.com');
      
      // 模拟表情摘要生成
      sandbox.stub(app.__get__('summarizeEmotions')).returns('表情摘要内容');
      
      // 获取AI分析函数
      const analyzeWithLLM = app.__get__('analyzeWithLLM');
      
      // 执行测试
      const asrText = '你好，我是面试者';
      const emotionResults = [
        { emotion: { data: { expression: { type: 'happy' } } } }
      ];
      
      const result = await analyzeWithLLM(asrText, emotionResults);
      
      // 验证结果
      expect(result).to.equal('这是面试分析结果');
      expect(mockWebSocket.send.calledOnce).to.be.true;
      expect(mockWebSocket.close.calledOnce).to.be.true;
    });
  });
  
  describe('6. API集成测试', () => {
    it('健康检查API应该返回正确状态', async () => {
      const response = await request.get('/health');
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status');
      expect(response.body).to.have.property('timestamp');
    });
    
    it('服务信息API应该返回正确信息', async () => {
      const response = await request.get('/api/info');
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('name');
      expect(response.body).to.have.property('version');
      expect(response.body).to.have.property('capabilities');
    });
    
    it('视频分析API应该拒绝无效的视频URL', async () => {
      const response = await request
        .post('/api/video/analyze')
        .send({
          videoUrl: 'invalid-url'
        });
      
      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('success').that.equals(false);
      expect(response.body).to.have.property('error');
    });
    
    it('视频分析API应该处理有效的视频URL', async () => {
      // 这个测试需要模拟整个处理流程，比较复杂
      // 模拟视频URL
      const mockVideoUrl = 'https://example.com/valid_interview.mp4';
      
      // 模拟视频下载
      nock('https://example.com')
        .get('/valid_interview.mp4')
        .reply(200, mockVideoBuffer, { 
          'Content-Type': 'video/mp4',
          'Content-Length': mockVideoBuffer.length
        });
      
      // 模拟processVideoWithLogging函数
      sandbox.stub(app.__get__('processVideoWithLogging')).callsFake(async (videoPath, res) => {
        // 模拟成功响应
        res.json({
          success: true,
          emotionTimeline: [],
          asrText: '模拟面试文本',
          analysisResult: '面试评估结果',
          processedFrames: 10
        });
      });
      
      // 模拟下载视频函数
      sandbox.stub(app.__get__('downloadVideoFromUrl')).resolves('/mock/path/video.mp4');
      
      // 执行测试
      const response = await request
        .post('/api/video/analyze')
        .send({
          videoUrl: mockVideoUrl
        });
      
      // 验证结果
      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('success').that.equals(true);
      expect(response.body).to.have.property('asrText');
      expect(response.body).to.have.property('analysisResult');
    });
  });
  
  describe('7. 错误处理测试', () => {
    it('应该处理视频下载失败', async () => {
      // 模拟视频URL
      const mockVideoUrl = 'https://example.com/missing_video.mp4';
      
      // 模拟404响应
      nock('https://example.com')
        .get('/missing_video.mp4')
        .reply(404);
      
      // 执行测试
      const response = await request
        .post('/api/video/analyze')
        .send({
          videoUrl: mockVideoUrl
        });
      
      // 验证结果
      expect(response.status).to.be.oneOf([400, 404]);
      expect(response.body).to.have.property('success').that.equals(false);
      expect(response.body).to.have.property('error');
    });
    
    it('应该处理大文件错误', async () => {
      // 模拟视频URL
      const mockVideoUrl = 'https://example.com/large_video.mp4';
      
      // 模拟带超大Content-Length的响应
      nock('https://example.com')
        .get('/large_video.mp4')
        .reply(200, 'mock_content', { 
          'Content-Type': 'video/mp4',
          'Content-Length': '200000000' // 200MB
        });
      
      // 执行测试
      const response = await request
        .post('/api/video/analyze')
        .send({
          videoUrl: mockVideoUrl
        });
      
      // 验证结果
      expect(response.status).to.be.oneOf([400, 413]);
      expect(response.body).to.have.property('success').that.equals(false);
      expect(response.body).to.have.property('error').that.includes('过大');
    });
  });
});