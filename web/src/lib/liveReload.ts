import { useEffect, useState } from 'react';

// Subscribes to server-side filesystem revisions. EventSource reconnects itself
// after network failures, so errors deliberately do not close the stream.
export function useLiveReload(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const rev = Number(e.data);
      if (!Number.isNaN(rev)) {
        setRevision((prev) => (rev > prev ? rev : prev));
      }
    };
    es.onerror = () => {
      // The browser automatically reconnects unless close() is called.
    };
    return () => es.close();
  }, []);
  return revision;
}
