// @ts-check
// 回報器只轉換官方事件，避免在載入回報器的程序內註冊考題 hook。
export default async function* reporter(/** @type {AsyncIterable<any>} */ source) {
  for await (const event of source) {
    if (event.type === 'test:summary') {
      yield JSON.stringify({ type: event.type, counts: event.data.counts, success: event.data.success }) + '\n';
    } else if (event.type === 'test:fail') {
      const error = event.data.details?.error;
      yield JSON.stringify({ type: event.type, name: event.data.name,
        error: String(error), cause: String(error?.cause) }) + '\n';
    }
  }
}
