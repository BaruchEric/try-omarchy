export class CdpConnection {
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.socket = new WebSocket(webSocketUrl);
    this.opened = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Chrome DevTools WebSocket failed to open.")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      const listeners = this.#listeners.get(message.method);
      if (!listeners) return;
      for (const listener of listeners) listener(message.params ?? {});
    });
    this.socket.addEventListener("close", () => {
      for (const { reject, method } of this.#pending.values()) {
        reject(new Error(`Chrome DevTools connection closed during ${method}.`));
      }
      this.#pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.opened;
    const id = ++this.#nextId;
    const response = new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject, method });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

export async function createPageConnection(devtoolsWebSocketUrl) {
  const endpoint = new URL(devtoolsWebSocketUrl);
  const httpEndpoint = new URL(`http://${endpoint.host}/json/new?about%3Ablank`);
  const response = await fetch(httpEndpoint, { method: "PUT", redirect: "error" });
  if (!response.ok) throw new Error(`Could not create browser target: HTTP ${response.status}.`);
  const target = await response.json();
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Browser target did not expose a DevTools WebSocket URL.");
  }
  return {
    connection: new CdpConnection(target.webSocketDebuggerUrl),
    targetId: target.id,
  };
}

export async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Browser evaluation failed.",
    );
  }
  return result.result?.value;
}
