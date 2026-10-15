'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * An item's or dish's own photo, or, when it doesn't load (gone from the bucket, a link that
 * ran out), the library picture it would have had (ADR 149): never a broken image.
 */
export function PhotoOrPicture({
  src,
  className,
  alt = '',
  testId,
  children,
}: {
  src: string;
  className: string;
  alt?: string;
  testId?: string;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // an image that failed before the page came alive fired its error with nobody listening
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) return children;
  return (
    // a presigned S3 URL that changes on every page: next/image would cache it for nothing
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img}
      src={src}
      alt={alt}
      data-testid={testId}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
