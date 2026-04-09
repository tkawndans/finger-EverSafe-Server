/** 네비게이션 정책용 URL ↔ 접두사 목록 매칭 (차단·허용 공통 로직) */

function urlMatchesAnyPrefixInList(urlStr, prefixList) {
  if (!urlStr || !prefixList || !prefixList.length) return false;
  const candidate = String(urlStr).trim();
  for (const prefix of prefixList) {
    const p = String(prefix).trim();
    if (!p) continue;
    if (candidate.startsWith(p)) return true;
    try {
      const U = new URL(candidate);
      const P = new URL(p);
      if (U.origin !== P.origin) continue;
      const pathU = U.pathname + U.search;
      const pathP = P.pathname + P.search;
      if (pathU.startsWith(pathP)) return true;
    } catch (_) {
      /* ignore */
    }
  }
  return false;
}

function urlMatchesBlockedPrefixes(urlStr, blockPrefixes) {
  return urlMatchesAnyPrefixInList(urlStr, blockPrefixes);
}

function urlMatchesAllowedPrefixes(urlStr, allowPrefixes) {
  if (!allowPrefixes || !allowPrefixes.length) return true;
  return urlMatchesAnyPrefixInList(urlStr, allowPrefixes);
}

function isUrlCompliantWithNavigationPolicy(u, allowPrefixes, blockPrefixes) {
  const allow = allowPrefixes || [];
  const block = blockPrefixes || [];
  if (urlMatchesBlockedPrefixes(u, block)) return false;
  if (allow.length && !urlMatchesAllowedPrefixes(u, allow)) return false;
  return true;
}

module.exports = {
  urlMatchesAnyPrefixInList,
  urlMatchesBlockedPrefixes,
  urlMatchesAllowedPrefixes,
  isUrlCompliantWithNavigationPolicy,
};
