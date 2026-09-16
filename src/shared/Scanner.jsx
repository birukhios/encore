import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

/**
 * Camera QR scanner. Uses the native BarcodeDetector where available, otherwise jsQR.
 * Calls onResult(text) once for the first code found. Camera access needs HTTPS or localhost.
 */
export default function Scanner({ onResult, hint = 'Point your camera at the QR code' }) {
  const video = useRef(null);
  const [status, setStatus] = useState('Starting camera…');
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let stream, frame, done = false, detector;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setFailed(window.isSecureContext ? 'This browser cannot use the camera.' : 'Camera scanning needs a secure (HTTPS) connection.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        setFailed(e?.name === 'NotAllowedError' ? 'Camera access was blocked. Allow camera access in your browser settings, or enter the code instead.' : 'No camera is available on this device.');
        return;
      }
      if (done) return stream.getTracks().forEach(t => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      if ('BarcodeDetector' in window) {
        try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
      }
      setStatus(hint);
      scan();
    }
    async function scan() {
      if (done) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth) {
        let text = null;
        try {
          if (detector) {
            const codes = await detector.detect(v);
            text = codes[0]?.rawValue || null;
          } else {
            const w = 480, h = Math.round((v.videoHeight / v.videoWidth) * 480);
            canvas.width = w; canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
          }
        } catch { detector = null; }
        if (text && !done) {
          done = true;
          navigator.vibrate?.(40);
          onResult(text);
          return;
        }
      }
      frame = setTimeout(() => requestAnimationFrame(scan), 180);
    }
    start();
    return () => { done = true; clearTimeout(frame); stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  if (failed) return <p className="notice warning" role="alert">{failed}</p>;
  return (
    <div className="scanner">
      <video ref={video} playsInline muted aria-label="Camera preview" />
      <div className="frame" aria-hidden="true" />
      <div className="status" role="status">{status}</div>
    </div>
  );
}
