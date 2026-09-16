import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Icon } from './ui';

export default function QR({ value, name = 'QR code', download = true, size = 220 }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { width: 480, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then(url => live && setSrc(url));
    return () => { live = false; };
  }, [value]);
  if (!src) return <div className="skeleton" style={{ width: size, height: size }} />;
  return (
    <div className="qr">
      <img src={src} width={size} height={size} style={{ width: size, height: size }} alt={name} />
      {download && (
        <a className="button noprint" href={src} download={name.replace(/[^\w-]+/g, '-') + '.png'}>
          <Icon name="download" />Download
        </a>
      )}
    </div>
  );
}
