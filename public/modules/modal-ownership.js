// @ts-check
// #modal-root 的「世代擁有權」核心（r6→r9，零依賴、DOM 無關＝可單元測）。
//
// 為什麼需要：全站表單/彈窗共用同一格 #modal-root。表單 onSubmit 有 await，回來時可能
// (1) 使用者已換頁、或 (2) 期間開了新彈窗——舊的成功 continuation 若無條件 close() 會清掉
// **後開的**彈窗、毀掉未存輸入；舊的失敗會在新頁報過期錯誤。
//
// 用兩個判準界定「我還擁有這一格」：
//   ① 世代章：每次有人接管（claim）就蓋新章；撤銷（release）也蓋新章。擋「期間開了新彈窗」。
//   ② 換頁序號：記住 claim 當下的**換頁**世代，使用者真的換頁後才失效。擋「換頁後舊 async 還動 UI」。
// ⚠️ ②吃的必須是「換頁」序號，不是「重繪」序號——r7 我接成重繪序號（routeSeq），結果開機報價更新
//    這種**同一頁的背景重繪**就把擁有權撤掉了：存檔成功卻不關窗、儲存鈕永遠灰。差別見 app.js 的路由段。
//
// release 是**有主才撤**（owner-scoped）：舊窗的 close 若已不是主人就不准蓋章，否則它會把
// 後開那個窗的擁有權一起洗掉（等於幫下一個 stale continuation 開門）。

/**
 * @param {{ readGen: () => number, writeGen: (g: number) => void, readNav?: () => number }} io
 *   readGen＝讀現在蓋在共用格上的章；writeGen＝蓋章；readNav＝讀現在的**換頁**世代（省略＝不看換頁）。
 *   三者由呼叫端接到實際載體（DOM dataset／currentNavSeq／測試假物件）。
 * @returns {(() => (() => boolean) & { release: () => void }) & { watch: () => () => boolean }}
 *   claim()：接管（蓋新章＋記住當下換頁世代），回傳 owns()＝章沒被蓋掉**且**還在同一頁。
 *   owns.release()：關窗時撤銷擁有權；**只有還是主人時才作用**（不是主人＝什麼都不做）。
 *   owns.handoff()：「我送出後排的下一窗現在還能不能開」——自己 close 造成的章變動**不算**別人接管
 *     （正常交接會蓋兩次章，用 owns()／watch() 判會把正常流程誤擋掉）。
 *   claim.watch()：**唯讀**版（不蓋章、不搶擁有權），回傳「從我看的那一刻起，這一格沒被別人接管／
 *     撤銷，使用者也沒換頁」。用在**開窗之前還有 await 的地方**（例如先問 /api/mode 再開密碼窗）：
 *     那段等待期間使用者可能關掉眼前的窗、改開別的窗，晚回來的窗不可以蓋掉它（r16 抓到的真實 bug）。
 *     ⚠️ 這裡**不能**用 claim()——claim 會蓋章，把當下那個窗的擁有權搶走（它之後就關不掉自己了）。
 */
export function makeModalOwnership({ readGen, writeGen, readNav }) {
  let gen = 0;
  const bump = () => { writeGen(++gen); return gen; };
  const claim = () => {
    const mine = bump();
    const nav = readNav ? readNav() : 0;
    // 有人在我之後 claim/release（蓋了更新的章）＝我不再擁有；或使用者換頁了＝也不再擁有。
    const owns = () => readGen() === mine && (readNav == null || readNav() === nav);
    let releasedAt = /** @type {number|null} */ (null);
    owns.release = () => { if (owns()) releasedAt = bump(); };   // 有主才撤：不是主人就別動別人的章（並記下交出去時的章）
    // 「我送出後排的下一窗，現在還能不能開？」——r18 的產線競態：密碼窗送出→等 preview→開預覽窗，
    // 這中間**正常流程本來就會蓋兩次章**（自己 close 時 release 一次、下一窗 claim 一次），所以不能用
    // watch()／owns() 判（正常關窗就會被誤擋）。真正要分辨的是：**動這一格的是不是我自己**——
    //   ✅ 還是我的（還沒關）｜✅ 就是我自己 release 之後那個章（我關掉、之後沒別人接手）→ 可以開；
    //   ❌ 章比那還新＝**別人接管了**（使用者關掉我、改開了別的窗）→ 舊 preview 不可以蓋掉它。
    //   ❌ 我根本沒 release 成功（owns 早就 false＝被搶走）→ 也不可以開。
    owns.handoff = () => (readGen() === mine || (releasedAt !== null && readGen() === releasedAt))
      && (readNav == null || readNav() === nav);
    return owns;
  };
  claim.watch = () => {
    const at = readGen();
    const nav = readNav ? readNav() : 0;
    return () => readGen() === at && (readNav == null || readNav() === nav);
  };
  return claim;
}
