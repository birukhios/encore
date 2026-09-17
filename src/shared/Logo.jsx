import React from 'react';

/**
 * Encore brand: a crimson "e" mark with a notch, followed by the "encore" wordmark.
 * The wordmark uses currentColor so it reads on light and black backgrounds.
 */
export function LogoMark({ size = 32, title }) {
  const id = React.useId();
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 100 100" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <mask id={id}>
          <rect width="100" height="100" fill="#fff" />
          {/* upper counter of the e */}
          <path d="M31 44c2-11 9.5-18 19.5-18S68 33 69.5 44z" fill="#000" />
          {/* mouth of the e, opening to the right */}
          <path d="M31 56h69v10H62c-3 6-8 9-13 9-8.5 0-15.5-6-18-19z" fill="#000" />
          {/* notch on the left edge */}
          <circle cx="4" cy="52" r="6" fill="#000" />
        </mask>
      </defs>
      <circle cx="50" cy="50" r="46" fill="#E61E32" mask={`url(#${id})`} />
    </svg>
  );
}

export default function Logo({ size = 30, showWordmark = true, className = '' }) {
  return (
    <span className={'logo ' + className} aria-label="Encore" role="img">
      <LogoMark size={size} />
      {showWordmark && <span className="logo-word" style={{ fontSize: size * 0.92 }} aria-hidden="true">encore</span>}
    </span>
  );
}
