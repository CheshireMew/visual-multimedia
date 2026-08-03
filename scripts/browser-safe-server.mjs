import process from "node:process";

const FIRST_SAFE_PORT = 49152;
const LAST_SAFE_PORT = 65535;

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenOnBrowserSafePort(server, host = "127.0.0.1", attempts = 256) {
  const width = LAST_SAFE_PORT - FIRST_SAFE_PORT + 1;
  const start = FIRST_SAFE_PORT + (process.pid % width);
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = FIRST_SAFE_PORT + ((start - FIRST_SAFE_PORT + offset) % width);
    try {
      return await listenOnce(server, port, host);
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw new Error(`无法在 ${FIRST_SAFE_PORT}–${LAST_SAFE_PORT} 中取得浏览器可访问的本地端口`);
}
