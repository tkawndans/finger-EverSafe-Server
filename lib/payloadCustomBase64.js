/**
 * 커스텀 Base64: 입력은 UTF-8 옥텟 기준(한글·서로게이트 안전).
 * 알파벳은 65자(64 심볼 + 패딩용 인덱스). 서버는 BROWSER_ADMIN_TOKEN(트림) 사용.
 */

const ALPHABET_LEN = 65;
const PAD_INDEX = 64;

/** 문자열 → UTF-8 바이트 배열 */
function stringToUtf8Bytes(str) {
  const bytes = [];
  const s = String(str);
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i++);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i < n) {
      const c2 = s.charCodeAt(i++);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

/** UTF-8 바이트 배열 → 문자열 */
function utf8BytesToString(bytes, start, end) {
  let st = start;
  if (st === undefined || st === null) st = 0;
  let en = end;
  if (en === undefined || en === null) en = bytes.length;
  let out = "";
  let i = st;
  while (i < en) {
    const c0 = bytes[i++] & 0xff;
    if (c0 < 0x80) {
      out += String.fromCharCode(c0);
    } else if (c0 < 0xe0) {
      if (i >= en) break;
      const c1 = bytes[i++] & 0xff;
      out += String.fromCharCode(((c0 & 0x1f) << 6) | (c1 & 0x3f));
    } else if (c0 < 0xf0) {
      if (i + 1 >= en) break;
      const c1 = bytes[i++] & 0xff;
      const c2 = bytes[i++] & 0xff;
      out += String.fromCharCode(((c0 & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f));
    } else {
      if (i + 2 >= en) break;
      const c1 = bytes[i++] & 0xff;
      const c2 = bytes[i++] & 0xff;
      const c3 = bytes[i++] & 0xff;
      let cp = ((c0 & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

/**
 * 구형: encodeURIComponent(plain)의 ASCII 바이트 → Base64 (호환 디코드용)
 */
function decodeLegacyPercentAsciiBytes(finalBytes) {
  let resultText = "";
  for (let m = 0; m < finalBytes.length; m++) {
    resultText += String.fromCharCode(finalBytes[m] & 0xff);
  }
  resultText = resultText.replace(/[^\x20-\x7E\uAC00-\uD7A3]/g, "");
  try {
    resultText = decodeURIComponent(resultText);
  } catch {
    /* ignore */
  }
  return resultText;
}

function decodeCustomBase64(encryptedData, alphabet) {
  if (encryptedData == null || alphabet == null || alphabet === "") {
    return "";
  }

  const cleanAlphabet = String(alphabet).replace(/[\s\t\n\r]/g, "");
  let cleanData = String(encryptedData).replace(/[\s\t\n\r]/g, "");

  let decodedUri = cleanData;
  try {
    decodedUri = decodeURIComponent(cleanData);
  } catch {
    decodedUri = cleanData;
  }

  const out = [];
  let outIdx = 0;
  const len = decodedUri.length;

  for (let i = 0; i < len; i += 4) {
    const c1 = decodedUri.charAt(i);
    const c2 = decodedUri.charAt(i + 1);
    const c3 = decodedUri.charAt(i + 2);
    const c4 = decodedUri.charAt(i + 3);

    const b1 = cleanAlphabet.indexOf(c1);
    const b2 = cleanAlphabet.indexOf(c2);
    const b3 = cleanAlphabet.indexOf(c3);
    const b4 = cleanAlphabet.indexOf(c4);

    if (b1 === -1 || b2 === -1) {
      break;
    }

    out[outIdx++] = (b1 << 2) | (b2 >> 4);

    if (b3 !== -1 && b3 < 64) {
      out[outIdx++] = ((b2 & 0x0f) << 4) | (b3 >> 2);

      if (b4 !== -1 && b4 < 64) {
        out[outIdx++] = ((b3 & 0x03) << 6) | b4;
      }
    }
  }

  const correctedBytes = out.slice(0, outIdx);

  let startIndex = -1;
  for (let k = 0; k < correctedBytes.length; k++) {
    if (correctedBytes[k] === 123) {
      startIndex = k;
      break;
    }
  }

  const startPos = startIndex !== -1 ? startIndex : 0;
  const finalBytes = correctedBytes.slice(startPos);

  const utf8Str = utf8BytesToString(finalBytes, 0, finalBytes.length);
  try {
    JSON.parse(utf8Str);
    return utf8Str;
  } catch {
    /* 구형 페이로드 또는 비JSON */
  }

  return decodeLegacyPercentAsciiBytes(finalBytes);
}

function encodeCustomBase64(input, alphabet) {
  if (input == null || alphabet == null || alphabet === "") {
    throw new Error("인코딩 입력이 올바르지 않습니다.");
  }

  const cleanAlphabet = String(alphabet).replace(/[\s\t\n\r]/g, "");
  if (cleanAlphabet.length !== ALPHABET_LEN) {
    throw new Error("알파벳 길이가 올바르지 않습니다.");
  }

  const bytes = stringToUtf8Bytes(String(input));
  let out = "";
  const L = bytes.length;
  let i = 0;

  while (i < L) {
    const a = bytes[i++];
    const b = i < L ? bytes[i++] : NaN;
    const c = i < L ? bytes[i++] : NaN;

    const p = a >> 2;
    const q = ((a & 0x03) << 4) | ((Number.isNaN(b) ? 0 : b) >> 4);
    const r = Number.isNaN(b) ? PAD_INDEX : ((b & 0x0f) << 2) | ((Number.isNaN(c) ? 0 : c) >> 6);
    const s = Number.isNaN(c) ? PAD_INDEX : c & 0x3f;

    let rOut = r;
    let sOut = s;
    if (Number.isNaN(b)) {
      rOut = PAD_INDEX;
      sOut = PAD_INDEX;
    } else if (Number.isNaN(c)) {
      sOut = PAD_INDEX;
    }

    out +=
      cleanAlphabet.charAt(p) +
      cleanAlphabet.charAt(q) +
      cleanAlphabet.charAt(rOut) +
      cleanAlphabet.charAt(sOut);
  }

  return out;
}

/**
 * POST /evaluate/warm: payload 는 반드시 문자열(클라이언트 커스텀 Base64). 디코드 후 JSON.parse.
 */
function prepareEvaluateWarmBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("요청 본문이 올바르지 않습니다.");
  }

  const b = { ...body };
  const p = b.payload;

  if (p === undefined) {
    throw new Error("payload 필드가 필요합니다.");
  }

  if (typeof p !== "string") {
    throw new Error("payload 는 인코딩된 문자열만 허용됩니다.");
  }

  const alphabet = (process.env.BROWSER_ADMIN_TOKEN || "").trim();
  if (alphabet.length !== ALPHABET_LEN) {
    throw new Error("일시적으로 요청을 처리할 수 없습니다. 관리자에게 문의하세요.");
  }

  let decoded;
  try {
    decoded = decodeCustomBase64(p, alphabet);
  } catch {
    throw new Error("payload 는 처리할 수 없습니다.");
  }

  if (!decoded || typeof decoded !== "string") {
    throw new Error("payload 내용을 해석할 수 없습니다.");
  }

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("payload 내용이 올바르지 않습니다.");
  }

  b.payload = parsed;
  return b;
}

module.exports = {
  stringToUtf8Bytes,
  utf8BytesToString,
  decodeCustomBase64,
  encodeCustomBase64,
  prepareEvaluateWarmBody,
  ALPHABET_LEN,
};
