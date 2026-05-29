// src/utils/headerUtils.ts

import { Response } from "express";

export function applyAuthHeaders(authResponseHeaders: Headers, res: Response) {
  const cookies = authResponseHeaders.getSetCookie
    ? authResponseHeaders.getSetCookie()
    : authResponseHeaders.get("set-cookie");

  if (cookies) {
    // 2. Forward the cookies to the client
    // res.append allows you to set multiple 'Set-Cookie' headers without overwriting existing ones
    res.append("Set-Cookie", cookies);
  }
}
