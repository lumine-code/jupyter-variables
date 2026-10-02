const MAX_RESPONSE_BYTES = 32768;
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const kernelIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description:
    "Exact kernel ID returned by ListJupyterKernels. Never defaults to the active kernel.",
};
const maxCharsSchema = {
  type: "integer",
  minimum: 64,
  maximum: 8000,
  default: 1000,
  description:
    "Maximum characters in each cached representation; the whole response is limited to 32 KiB.",
};

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function text(value, max) {
  if (typeof value !== "string") return null;
  let result = value.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}

function size(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function context(getSession, args) {
  if (!args || typeof args.kernelId !== "string" || !args.kernelId || args.kernelId.length > 256)
    throw new TypeError(
      "kernelId is required and must be a nonempty string of at most 256 characters.",
    );
  const base = { kernelId: args.kernelId, source: "cached-namespace", cachedAt: null, stale: null };
  const session = getSession();
  if (!session?.provider || session.destroyed)
    return {
      base: {
        ...base,
        status: "provider-unavailable",
        reason: "The jupyter.kernel provider is not connected.",
      },
    };
  let kernel;
  try {
    kernel = session.provider
      .getRunningKernels()
      .find((entry) => entry.id === args.kernelId && !entry.destroyed);
  } catch {
    return {
      base: {
        ...base,
        status: "provider-unavailable",
        reason: "The kernel provider is no longer available.",
      },
    };
  }
  if (!kernel)
    return {
      base: { ...base, status: "kernel-not-found", reason: "No running kernel has this ID." },
    };
  if (typeof kernel.language !== "string" || kernel.language.toLowerCase() !== "python") {
    return {
      base: {
        ...base,
        status: "unsupported-kernel",
        reason: "The Variables namespace cache supports Python kernels only.",
      },
    };
  }
  // storeFor can create a store and auto-fetch. This read-only path must never
  // call it, reveal the panel, inspect a value or execute namespace Python.
  const store = session.stores.get(kernel);
  if (!store || store.destroyed || !store.cachedAt)
    return {
      base: {
        ...base,
        status: "cache-unavailable",
        reason:
          "The Variables panel has not cached this kernel's namespace. Refresh it explicitly in the panel first.",
      },
    };
  let stale = null;
  if (
    store._fetching ||
    store.lastRefreshError ||
    (kernel.executionState && kernel.executionState !== "idle") ||
    store.cachedExecutionCount !== (kernel.executionCount ?? null) ||
    store.cachedExecutionTime !== (kernel.lastExecutionTime ?? null)
  )
    stale = true;
  else if (
    kernel.executionState === "idle" &&
    Number.isFinite(store.cachedExecutionCount) &&
    typeof store.cachedExecutionTime === "string"
  )
    stale = false;
  return {
    store,
    base: {
      ...base,
      status: "available",
      cachedAt: store.cachedAt,
      stale,
      executionCount: store.cachedExecutionCount,
      lastExecutionTime: store.cachedExecutionTime,
      refreshing: Boolean(store._fetching),
      lastRefreshError: text(store.lastRefreshError, 1000),
    },
  };
}

function variableSnapshot(variable, maxChars) {
  const repr = {};
  const availableRepresentations = [];
  let truncated = false;
  const formats = {
    text: "text/plain",
    pretty: "text/plain",
    markdown: "text/markdown",
    html: "text/html",
    png: "image/png",
    jpeg: "image/jpeg",
  };
  for (const [key, mime] of Object.entries(formats)) {
    const value = variable.repr?.[key];
    if (typeof value !== "string") continue;
    if (!availableRepresentations.includes(mime)) availableRepresentations.push(mime);
    if (key === "png" || key === "jpeg") continue;
    repr[key] = text(value, maxChars);
    if (repr[key].length < value.length) truncated = true;
  }
  const name = text(variable.name, 1024);
  const type = text(variable.type, 128);
  return {
    name,
    type,
    repr,
    availableRepresentations,
    binaryOmitted: availableRepresentations.some((mime) => mime.startsWith("image/")),
    truncated:
      truncated ||
      name !== variable.name ||
      (typeof variable.type === "string" && type !== variable.type),
  };
}

function list(getSession, args = {}) {
  const offset = integer(args.offset, 0, 0, 1000000, "offset");
  const limit = integer(args.limit, 50, 1, 200, "limit");
  const maxChars = integer(args.maxChars, 1000, 64, 8000, "maxChars");
  if (
    args.nameContains !== undefined &&
    (typeof args.nameContains !== "string" || args.nameContains.length > 256)
  )
    throw new TypeError("nameContains must be a string of at most 256 characters.");
  const { base, store } = context(getSession, args);
  if (!store) return { ...base, variables: [], total: 0, offset, nextOffset: null };
  const needle = args.nameContains?.toLowerCase() || "";
  const selected = store.variables.filter(
    (variable) =>
      typeof variable?.name === "string" && variable.name.toLowerCase().includes(needle),
  );
  const result = {
    ...base,
    variables: [],
    total: selected.length,
    offset,
    requestedLimit: limit,
    nextOffset: null,
    responseLimited: false,
  };
  for (const variable of selected.slice(offset, offset + limit)) {
    let chars = maxChars;
    let snapshot = variableSnapshot(variable, chars);
    while (size(snapshot) > MAX_RESPONSE_BYTES / 2 && chars > 16) {
      chars = Math.floor(chars / 2);
      snapshot = variableSnapshot(variable, chars);
    }
    result.variables.push(snapshot);
    if (size(result) > MAX_RESPONSE_BYTES - 128) {
      result.variables.pop();
      result.responseLimited = true;
      break;
    }
  }
  const next = offset + result.variables.length;
  result.nextOffset = next < selected.length ? next : null;
  return result;
}

function get(getSession, args = {}) {
  if (typeof args.name !== "string" || !args.name || args.name.length > 4096)
    throw new TypeError("name must be a nonempty string of at most 4096 characters.");
  let maxChars = integer(args.maxChars, 1000, 64, 8000, "maxChars");
  const { base, store } = context(getSession, args);
  if (!store) return { ...base, variable: null };
  const variable = store.variables.find((entry) => entry.name === args.name);
  if (!variable)
    return {
      ...base,
      status: "not-found",
      reason:
        "This name is absent from the cached namespace; the live kernel has not been queried.",
      variable: null,
    };
  let result = { ...base, variable: variableSnapshot(variable, maxChars) };
  while (size(result) > MAX_RESPONSE_BYTES && maxChars > 16) {
    maxChars = Math.floor(maxChars / 2);
    result = { ...base, variable: variableSnapshot(variable, maxChars) };
  }
  return result;
}

function createTools(getSession) {
  return [
    {
      name: "ListJupyterVariables",
      title: "List cached Jupyter variables",
      description:
        "Read a bounded cached namespace for one explicit kernel. Does not open the panel, refresh, inspect or execute Python. A missing cache is reported; stale=false means no known execution since the snapshot, not a live kernel read. Image payloads are omitted.",
      inputSchema: {
        type: "object",
        properties: {
          kernelId: kernelIdSchema,
          offset: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          nameContains: { type: "string", maxLength: 256 },
          maxChars: maxCharsSchema,
        },
        required: ["kernelId"],
        additionalProperties: false,
      },
      annotations,
      execute: (args) => list(getSession, args),
    },
    {
      name: "GetJupyterVariable",
      title: "Get a cached Jupyter variable",
      description:
        "Read the cached type and bounded representations of a named variable in one explicit kernel. Never evaluates repr, sends inspect, executes code or refreshes the panel. Returns availability, snapshot time and conservative staleness; excludes image payloads.",
      inputSchema: {
        type: "object",
        properties: {
          kernelId: kernelIdSchema,
          name: { type: "string", minLength: 1, maxLength: 4096 },
          maxChars: maxCharsSchema,
        },
        required: ["kernelId", "name"],
        additionalProperties: false,
      },
      annotations,
      execute: (args) => get(getSession, args),
    },
  ];
}

module.exports = { createTools, MAX_RESPONSE_BYTES };
