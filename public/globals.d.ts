// 瀏覽器全域宣告（給型別檢查用，零 runtime）。
// Chart.js 以 <script> 標籤載入本機 vendor（public/vendor/chart.umd.js），不是 import——
// 在此宣告全域 Chart，型別檢查才認得（標 any：圖表設定物件龐大，逐欄型別化投報率低）。
declare var Chart: any;
