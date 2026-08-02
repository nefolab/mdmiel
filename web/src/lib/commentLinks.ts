/** A text or link fragment produced from a comment body. */
export type BodySegment =
  | { type: 'text'; value: string }
  | { type: 'link'; url: string; internal: boolean };

export interface LinkLocation {
  origin: string;
  hostname: string;
}

const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+;=%]+/gi;
const TRAILING_NOISE = new Set([
  '.', ';', ':', '!', '?', "'", '"', ')', ']', '}', '>', ',',
  '、', '。', '）', '」', '』', '】', '・',
]);
const CLOSING_BRACKETS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) {
    if (current === character) count += 1;
  }
  return count;
}

function trimTrailingNoise(value: string): string {
  let end = value.length;

  while (end > 0) {
    const trailing = value[end - 1];
    if (!TRAILING_NOISE.has(trailing)) break;

    const opening = CLOSING_BRACKETS[trailing];
    if (opening) {
      const remainder = value.slice(0, end - 1);
      if (countCharacter(remainder, opening) > countCharacter(remainder, trailing)) {
        break;
      }
    }

    end -= 1;
  }

  return value.slice(0, end);
}

/** Whether a hash targets one of mdmiel's share routes. */
export function isShareRouteHash(hash: string): boolean {
  if (/^#\/comment\/[^/?#]+(?:[/?].*)?$/.test(hash)) return true;
  if (!hash.startsWith('#/view?')) return false;

  const params = new URLSearchParams(hash.slice('#/view?'.length));
  return ['path', 'left', 'right'].some((key) => Boolean(params.get(key)));
}

/** Whether a hostname identifies the local loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '[::1]';
}

/** Whether a URL points to a share route on the current mdmiel instance. */
export function isInternalLink(url: URL, location: LinkLocation): boolean {
  if (!isShareRouteHash(url.hash)) return false;
  if (url.origin === location.origin) return true;
  return isLoopbackHostname(url.hostname) && isLoopbackHostname(location.hostname);
}

/** Split a comment body into text and clickable URL fragments without changing its text. */
export function splitBodyIntoSegments(body: string, location: LinkLocation): BodySegment[] {
  const segments: BodySegment[] = [];
  let cursor = 0;

  const appendText = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.type === 'text') {
      previous.value += value;
    } else {
      segments.push({ type: 'text', value });
    }
  };

  for (const match of body.matchAll(URL_PATTERN)) {
    const rawMatch = match[0];
    const matchStart = match.index;
    const matchEnd = matchStart + rawMatch.length;
    const candidate = trimTrailingNoise(rawMatch);

    appendText(body.slice(cursor, matchStart));

    let parsed: URL | null = null;
    if (/^https?:\/\/.+/i.test(candidate)) {
      try {
        parsed = new URL(candidate);
      } catch {
        parsed = null;
      }
    }

    // Keep this allowlist even though URL_PATTERN currently only detects HTTP(S): if that
    // pattern is broadened later, this becomes the sole scheme validation boundary.
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      segments.push({
        type: 'link',
        url: candidate,
        internal: isInternalLink(parsed, location),
      });
      appendText(rawMatch.slice(candidate.length));
    } else {
      appendText(rawMatch);
    }

    cursor = matchEnd;
  }

  appendText(body.slice(cursor));
  return segments.length > 0 ? segments : [{ type: 'text', value: body }];
}
