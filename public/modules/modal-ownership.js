// @ts-check
// #modal-root 的「世代擁有權」核心（r6，零依賴、DOM 無關＝可單元測）。
//
// 為什麼需要：全站表單/彈窗共用同一格 #modal-root。表單 onSubmit 有 await，回來時可能已切頁或
// 期間開了新彈窗——舊的成功 continuation 若無條件 close() 會清掉**後開的**彈窗、毀掉未存輸入。
// 用單調遞增的世代章判擁有權：每次有彈窗接管就蓋新章，舊持有者的 owns() 立刻變 false。
// app.js 的 claimModalRoot 把 readGen/writeGen 接到 #modal-root 的 dataset；本檔只管純邏輯。

/**
 * @param {{ readGen: () => number, writeGen: (g: number) => void }} io
 *   readGen＝讀現在蓋在共用格上的章；writeGen＝蓋章。兩者由呼叫端接到實際載體（DOM dataset／測試假物件）。
 * @returns {() => (() => boolean)} claim()：接管（遞增並蓋新章），回 owns()＝現在的章還是不是我這一份的。
 */
export function makeModalOwnership({ readGen, writeGen }) {
  let gen = 0;
  return () => {
    const mine = ++gen;
    writeGen(mine);
    return () => readGen() === mine;   // 有人在我之後 claim（蓋了更新的章）＝我不再擁有這一格
  };
}
