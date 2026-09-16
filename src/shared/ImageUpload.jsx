import React, { useState } from 'react';
import { api, readFileAsBase64 } from './api';
import { ErrorText, Icon } from './ui';

export default function ImageUpload({ label = 'Cover image', value, onChange, square, hint = 'JPEG, PNG or WebP · up to 5 MB' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function pick(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5000000) return setError('Choose an image smaller than 5 MB.');
    setBusy(true);
    setError('');
    try {
      onChange((await api('upload', { data: await readFileAsBase64(file) })).url);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field" style={{ display: 'grid', gap: 7 }}>
      <span style={{ fontWeight: 650, fontSize: 13 }}>{label}</span>
      <label className={'upload' + (square ? ' square' : '')}>
        {value ? <img src={value} alt="" /> : <><Icon name="download" /><b>{busy ? 'Uploading…' : 'Choose an image'}</b>{!square && <small>{hint}</small>}</>}
        {value && <span className="replace">{busy ? 'Uploading…' : 'Replace'}</span>}
        <input aria-label={label} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={pick} />
      </label>
      {value && <button type="button" className="linklike small" style={{ justifySelf: 'start' }} onClick={() => onChange('')}>Remove image</button>}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
