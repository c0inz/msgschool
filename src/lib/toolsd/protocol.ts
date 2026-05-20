/**
 * msgschool-toolsd wire protocol.
 *
 * Length-prefixed JSON frames over a unix socket. One request → one
 * response per connection. See docs/TOOLSD_SPEC.md §5.
 */

export const SOCKET_PATH = process.env.MSGSCHOOL_TOOLSD_SOCKET || "/run/msgschool/toolsd.sock";
export const PROTOCOL_VERSION = 1;

export type ToolErrorCode =
  | "AUTH_FAILED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_HTTP"
  | "IP_BLOCKED"
  | "RATE_LIMITED"
  | "INVALID_ARG"
  | "PEER_UNKNOWN"
  | "TOOL_UNKNOWN"
  | "INTERNAL";

export type ToolRequest = {
  v: 1;
  tg: number;
  tool: string;
  args: unknown;
  request_id: string;
};

export type ToolResponse =
  | { v: 1; request_id: string; result: unknown }
  | { v: 1; request_id: string; error: { code: ToolErrorCode; message: string } };

export class ToolError extends Error {
  code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  if (body.length > 16 * 1024 * 1024) {
    throw new ToolError("INVALID_ARG", `frame too large: ${body.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function frameReader(): {
  push: (chunk: Buffer) => Buffer | null;
} {
  let buf = Buffer.alloc(0);
  let expected: number | null = null;
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      if (expected === null && buf.length >= 4) {
        expected = buf.readUInt32BE(0);
        if (expected > 16 * 1024 * 1024) {
          throw new ToolError("INVALID_ARG", `frame too large: ${expected} bytes`);
        }
      }
      if (expected !== null && buf.length >= 4 + expected) {
        const body = buf.subarray(4, 4 + expected);
        buf = buf.subarray(4 + expected);
        const e = expected;
        expected = null;
        return body;
      }
      return null;
    },
  };
}
