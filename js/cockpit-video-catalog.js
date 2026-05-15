/**
 * 与 E:\21_Coding\vui\js\app.js 中 CONFIG.videos 保持同源，座舱内嵌视频点播复用同一批演示片源。
 */
(function () {
  "use strict";

  /** @type {Array<{ id:number,title:string,duration:string,thumbnail:string,url:string }>} */
  window.COCKPIT_VIDEO_LIST = [
    {
      id: 1,
      title: "1. 自然风景 (Big Buck Bunny)",
      duration: "0:10",
      thumbnail: "🌸",
      url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4",
    },
    {
      id: 2,
      title: "2. [中文] 中文教学 (25个必学短语)",
      duration: "6:39",
      thumbnail: "🗣️",
      url: "https://upload.wikimedia.org/wikipedia/commons/7/73/25_Essential_Chinese_Phrases_You_NEED_to_Know_Before_Visiting_China%21.webm",
    },
    {
      id: 3,
      title: "3. 海洋世界 (Jellyfish)",
      duration: "0:10",
      thumbnail: "🌊",
      url: "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_2MB.mp4",
    },
    {
      id: 4,
      title: "4. [中文] 校长致辞 (徐兴庆)",
      duration: "0:10",
      thumbnail: "🎓",
      url: "https://upload.wikimedia.org/wikipedia/commons/8/8c/%E4%B8%AD%E5%9B%BD%E6%96%87%E5%8C%96%E5%A4%A7%E5%AD%A6%E6%A0%A1%E9%95%BF%E5%BE%90%E5%85%B4%E5%BA%86%E8%87%B4%E8%BE%9E.webm",
    },
    {
      id: 5,
      title: "5. 旅行记录 (城市风景)",
      duration: "0:20",
      thumbnail: "✈️",
      url: "https://download.samplelib.com/mp4/sample-20s.mp4",
    },
    {
      id: 6,
      title: "6. [中文] 高原直播 (嘉绒服饰介绍)",
      duration: "3:12",
      thumbnail: "👗",
      url: "https://upload.wikimedia.org/wikipedia/commons/c/cf/%E4%BD%95%E7%91%9C%E5%A8%9Fdressed_in_Gyalrong_costume.webm",
    },
    {
      id: 7,
      title: "7. 动画短片 (交通实拍)",
      duration: "0:15",
      thumbnail: "🎭",
      url: "https://download.samplelib.com/mp4/sample-15s.mp4",
    },
    {
      id: 8,
      title: "8. [中文] 中文招募短片 (CIA)",
      duration: "2:33",
      thumbnail: "🔊",
      url: "https://upload.wikimedia.org/wikipedia/commons/5/59/CIA_Chinese_recruiting_video-_%E9%80%89%E6%8B%A9%E5%90%88%E4%BD%9C%E7%9A%84%E5%8E%9F%E5%9B%A0%EF%BC%9A%E6%88%90%E4%B8%BA%E5%91%BD%E8%BF%90%E7%9A%84%E4%B8%BB%E5%AE%B0%E8%80%85.webm",
    },
    {
      id: 9,
      title: "9. 创意广告 (Sample)",
      duration: "0:05",
      thumbnail: "📱",
      url: "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
    },
    {
      id: 10,
      title: "10. 动画电影 (Big Buck Bunny)",
      duration: "0:10",
      thumbnail: "🎬",
      url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4",
    },
  ];
})();
