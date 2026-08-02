import { MouseEvent } from 'react';
import { splitBodyIntoSegments } from '../lib/commentLinks';

interface CommentBodyProps {
  body: string;
  className?: string;
}

export function CommentBody({ body, className }: CommentBodyProps): JSX.Element {
  const segments = splitBodyIntoSegments(body, {
    origin: window.location.origin,
    hostname: window.location.hostname,
  });

  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>, internal: boolean) => {
    event.stopPropagation();
    if (!internal) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    const targetHash = new URL(event.currentTarget.href).hash;
    const before = window.location.hash;
    window.location.hash = targetHash;
    if (window.location.hash === before) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  };

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          segment.value
        ) : (
          <a
            key={index}
            href={segment.url}
            className="comment-body-link"
            title={new URL(segment.url).origin}
            target={segment.internal ? undefined : '_blank'}
            rel={segment.internal ? undefined : 'noopener noreferrer'}
            onClick={(event) => handleLinkClick(event, segment.internal)}
          >
            {segment.url}
          </a>
        )
      )}
    </span>
  );
}
