import React, { useState } from 'react';
import { api, readFileAsBase64 } from '../../shared/api';
import { Avatar, ErrorText, Field, Icon } from '../../shared/ui';
import { useRunner } from './common';

export function Profile({ ctx }) {
  const { session } = ctx;
  const profile = useRunner();
  const password = useRunner();
  const [name, setName] = useState(session.user.name);
  const saveProfile = patch => profile.run(async () => {
    ctx.setSession(await api('profile', { name, avatar: session.user.avatar, ...patch }));
    ctx.toast(patch.avatar !== undefined ? (patch.avatar ? 'Photo updated' : 'Photo removed') : 'Profile updated');
  });
  return (
    <div className="grid-2">
      <section className="card stack lg">
        <div className="profile-card">
          <label className="avatar-upload" title="Change photo">
            <Avatar name={session.user.name} src={session.user.avatar} size={88} />
            <span className="avatar-upload-badge"><Icon name="pencil" size="sm" /></span>
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload profile photo" disabled={profile.busy}
              onChange={async e => {
                const file = e.target.files[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 5000000) return profile.setError('Choose a photo smaller than 5 MB.');
                const { url } = await profile.run(async () => api('upload', { data: await readFileAsBase64(file) })) || {};
                if (url) saveProfile({ avatar: url });
              }} />
          </label>
          <div className="grow">
            <h2>{session.user.name}</h2>
            <p>{session.user.role} · {session.state.name}</p>
            {session.user.avatar && <button className="linklike small" onClick={() => saveProfile({ avatar: '' })} disabled={profile.busy}>Remove photo</button>}
          </div>
        </div>
        <form className="form" onSubmit={e => { e.preventDefault(); saveProfile({}); }}>
          <Field label="Full name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required />
          <Field label="Email address" value={session.user.email} readOnly hint="Contact your workspace owner to change your sign-in email." />
          <ErrorText>{profile.error}</ErrorText>
          <div className="row"><button className="primary" disabled={profile.busy || !name.trim() || name === session.user.name}>Save name</button></div>
        </form>
        <hr />
        <button className="ghost danger-text" style={{ justifySelf: 'start' }} onClick={async () => { try { await api('signout', {}); } finally { location.assign('/admin/signin'); } }}>Sign out</button>
      </section>
      <section className="card">
        <h2>Password & security</h2>
        <p style={{ margin: '6px 0 16px' }}>Changing your password signs you out everywhere.</p>
        <form className="form" onSubmit={e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); password.run(async () => { await api('password', v); location.assign('/admin/signin'); }); }}>
          <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
          <Field label="New password" name="password" type="password" minLength={12} autoComplete="new-password" required hint="At least 12 characters." />
          <ErrorText>{password.error}</ErrorText>
          <div className="row"><button className="primary" disabled={password.busy}>Change password</button></div>
        </form>
      </section>
    </div>
  );
}
