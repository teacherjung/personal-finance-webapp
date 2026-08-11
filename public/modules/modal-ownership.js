// @ts-check
// #modal-root 的「世代擁有權」核心（r6→r7，零依賴、DOM 無關＝可單元測）。
//
// 為什麼需要：全站表單/彈窗共用同一格 #modal-root。表單 onSubmit 有 await，回來時可能
// (1) 已切頁、或 (2) 期間開了新彈窗——舊的成功 continuation 若無條件 close() 會清掉**後開的**
// 彈窗、毀掉未存輸入；舊的失敗會在新頁報過期錯誤。
//
// 用兩個判準界定「我還擁有這一格」：
//   ① 世代章：每次有人接管（claim）就蓋新章；蓋章／撤銷（release）都會讓舊持有者的 owns() 變 false。
//      —— 擋「同一頁期間開了新彈窗／關了窗」的誤 close。
//   ② 路由序號：記住 claim 當下的頁面序號，切頁後 routeSeq 會前進 → owns() 變 false。
//      —— 擋「單純切頁、沒有新彈窗」時舊 async 仍 close()/toast 的漏網（r7 Codex 指出）。
// app.js 的 claimModalRoot/releaseModalRoot 把 readGen/writeGen/readRoute 接到 #modal-root 的
// dataset 與 currentRouteSeq；本檔只管純邏輯。

/**
 * @param {{ readGen: () => number, writeGen: (g: number) => void, readRoute?: () => number }} io
 *   readGen＝讀現在蓋在共用格上的章；writeGen＝蓋章；readRoute＝讀現在的路由序號（省略＝不看路由）。
 *   三者由呼叫端接到實際載體（DOM dataset／currentRouteSeq／測試假物件）。
 * @returns {(() => (() => boolean)) & { release: () => void }}
 *   claim()：接管（蓋新章＋記住當下路由），回 owns()＝章沒被蓋掉**且**還在同一頁。
 *   claim.release()：撤銷擁有權（蓋新章讓現任持有者的 owns() 立刻變 false）——關窗時呼叫。
 */
export function makeModalOwnership({ readGen, writeGen, readRoute }) {
  let gen = 0;
  const bump = () => { writeGen(++gen); return gen; };
  const claim = () => {
    const mine = bump();
    const route = readRoute ? readRoute() : 0;
    // 有人在我之後 claim/release（蓋了更新的章）＝我不再擁有；或路由前進（切頁）＝也不再擁有。
    return () => readGen() === mine && (readRoute == null || readRoute() === route);
  };
  claim.release = () => { bump(); };
  return claim;
}
