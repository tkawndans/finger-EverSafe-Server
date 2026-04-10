/**
 * 클라이언트 encodeCustomBase64 와 짝이 되는 디코더.
 * 알파벳은 65자(64 심볼 + 패딩용 인덱스). 서버는 환경 변수에서 읽은 값(트림)을 알파벳으로 쓴다.
 */

const ALPHABET_LEN = 65;

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

  let resultText = "";
  for (let m = 0; m < finalBytes.length; m++) {
    resultText += String.fromCharCode(finalBytes[m]);
  }

  resultText = resultText.replace(/[^\x20-\x7E\uAC00-\uD7A3]/g, "");

  try {
    resultText = decodeURIComponent(resultText);
  } catch {
    /* ignore */
  }

  return resultText;
}

/**
 * decodeCustomBase64 의 역. plain 은 JSON 문자열 등 UTF-16 문자열.
 * 내부적으로 encodeURIComponent 후 바이트열을 65자 알파벳(64+패딩)으로 인코딩한다.
 */
function encodeCustomBase64(plain, alphabet) {
  if (plain == null || alphabet == null || alphabet === "") {
    throw new Error("인코딩 입력이 올바르지 않습니다.");
  }

  const cleanAlphabet = String(alphabet).replace(/[\s\t\n\r]/g, "");
  if (cleanAlphabet.length !== ALPHABET_LEN) {
    throw new Error("알파벳 길이가 올바르지 않습니다.");
  }

  const table = cleanAlphabet.slice(0, 64);
  const pad = cleanAlphabet[64];

  const uriStr = encodeURIComponent(String(plain));
  const bytes = [];
  for (let i = 0; i < uriStr.length; i++) {
    const c = uriStr.charCodeAt(i);
    if (c > 255) {
      throw new Error("인코딩할 수 없는 문자가 포함되어 있습니다.");
    }
    bytes.push(c);
  }

  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b1 << 16) | (b2 << 8) | b3;
    const k1 = (n >> 18) & 63;
    const k2 = (n >> 12) & 63;
    const k3 = (n >> 6) & 63;
    const k4 = n & 63;
    out += table[k1] + table[k2];
    if (i + 1 < bytes.length) {
      out += table[k3];
    } else {
      out += pad;
    }
    if (i + 2 < bytes.length) {
      out += table[k4];
    } else {
      out += pad;
    }
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
  decodeCustomBase64,
  encodeCustomBase64,
  prepareEvaluateWarmBody,
  ALPHABET_LEN,
};
