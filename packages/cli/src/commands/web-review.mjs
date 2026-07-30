import { openBrowser as defaultOpenBrowser } from '../open-browser.mjs';
import { startWebReviewServer as defaultStartWebReviewServer } from '../web-server.mjs';

function printLine(stream, message = '') {
  stream.write(`${message}\n`);
}

export async function handleWebReview({
  root,
  session,
  stdout,
  open = true,
  openBrowser = defaultOpenBrowser,
  startServer = defaultStartWebReviewServer,
} = {}) {
  const server = await startServer({ root, sessionId: session.sessionId });

  try {
    printLine(stdout, `Web review: ${server.url}`);
    if (open) {
      await openBrowser(server.url);
    }

    const result = await server.waitForCompletion();
    if (result.reportPath) {
      printLine(stdout, `Review report: ${result.reportPath}`);
    }
    return result;
  } finally {
    await server.close();
  }
}
