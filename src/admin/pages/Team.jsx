import React, { useState } from 'react';
import { api } from '../../shared/api';
import { ROLE_PAGES } from '../roles';
import { Avatar, copyText, ErrorText, Field, Icon, Modal } from '../../shared/ui';
import { PageActions, useRunner } from './common';

const ROLE_INFO = [
  ['Admin', 'Everything: events, menu, tables, orders, bookings, team and settings.'],
  ['Service', 'Floor staff: the cashier queue, then preparing, delivering and cancelling orders.'],
  ['Cashier', 'The cashier queue only. Once a cashier claims an order, other cashiers no longer see it.'],
  ['Gate', 'Facilitators at the entrance: scan tickets, take cash for unpaid tickets, check guests in.'],
];

// Tick the pages a member may open; Guide is always available.
function PageChooser({ role, value, onChange }) {
  const options = ROLE_PAGES[role].filter(p => p !== 'Guide');
  return (
    <fieldset className="stack">
      <legend className="small">What they can see and use</legend>
      <div className="row wrap">
        {options.map(p => (
          <label key={p} className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={value.includes(p)} onChange={e => onChange(e.target.checked ? [...value, p] : value.filter(x => x !== p))} />{p}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Team({ ctx }) {
  const { session, state, role } = ctx;
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState('');
  const [newRole, setNewRole] = useState('Service');
  const [newPages, setNewPages] = useState(ROLE_PAGES.Service);
  const [editing, setEditing] = useState(null); // { member, pages }
  const { busy, error, run } = useRunner();
  const chosen = (r, list) => list.filter(p => ROLE_PAGES[r].includes(p) && p !== 'Guide');
  const saveAccess = () => run(async () => {
    ctx.setSession(await api('team/access', { id: editing.member.id, pages: chosen(editing.member.role, editing.pages) }));
    ctx.toast(`${editing.member.name} can now open ${chosen(editing.member.role, editing.pages).join(', ')}`);
    setEditing(null);
  });
  const remove = m => confirm(`Remove ${m.name} from ${state.name}? They will be signed out immediately.`) &&
    run(async () => { ctx.setSession(await api('team/remove', { id: m.id })); ctx.toast(m.name + ' was removed'); });
  const invite = e => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email');
    run(async () => { setLink((await api('invite', { email, role: newRole, pages: chosen(newRole, newPages) })).url); });
  };
  return (
    <>
      {ctx.canManage && <PageActions><button className="primary" onClick={() => { setInviting(true); setLink(''); }}><Icon name="add" />Invite member</button></PageActions>}
      <section className="card">
        <div className="card-head"><h2>{state.name} team</h2><span className="badge neutral">{session.team.length} members</span></div>
        <ErrorText>{!inviting && error}</ErrorText>
        <div className="list">
          {session.team.map(m => (
            <div className="listrow" key={m.id}>
              <Avatar name={m.name} src={m.avatar} />
              <div className="grow"><b>{m.name}{m.id === session.user.id && <span className="muted"> (you)</span>}</b><small>{m.email}</small></div>
              <span className="badge neutral">{m.role}</span>
              {ctx.canManage && m.role !== 'Owner' && m.id !== session.user.id && <button className="ghost" onClick={() => setEditing({ member: m, pages: m.pages || ROLE_PAGES[m.role] })} disabled={busy}>Access</button>}
              {role === 'Owner' && m.role !== 'Owner' && <button className="ghost danger-text" onClick={() => remove(m)} disabled={busy}>Remove</button>}
            </div>
          ))}
        </div>
      </section>
      {editing && (
        <Modal title={`What ${editing.member.name} can open`} eyebrow={editing.member.role} onClose={() => setEditing(null)}
          footer={<><button onClick={() => setEditing(null)}>Cancel</button><button className="primary" onClick={saveAccess} disabled={busy || !chosen(editing.member.role, editing.pages).length}>Save access</button></>}>
          <PageChooser role={editing.member.role} value={editing.pages} onChange={pages => setEditing({ ...editing, pages })} />
          <p className="small">They see the change the next time their screen refreshes.</p>
          <ErrorText>{error}</ErrorText>
        </Modal>
      )}
      <section className="card">
        <h3>Roles</h3>
        <div className="list" style={{ marginTop: 8 }}>
          {[['Owner', 'Everything, always. Only the owner can remove members.'], ...ROLE_INFO].map(([r, d]) => (
            <div className="listrow" key={r}><b style={{ width: 130 }}>{r}</b><p className="small grow">{d}</p></div>
          ))}
        </div>
      </section>
      {inviting && (
        <Modal title={link ? 'Your invitation is ready' : 'Invite a teammate'} eyebrow={state.name} onClose={() => setInviting(false)}
          footer={link
            ? <><button onClick={async () => ctx.toast(await copyText(link) ? 'Invitation link copied' : 'Select and copy the link')}>Copy link</button><button className="primary" onClick={() => setInviting(false)}>Done</button></>
            : <><button onClick={() => setInviting(false)}>Cancel</button><button className="primary" form="invite-form" disabled={busy || !chosen(newRole, newPages).length}>{busy ? 'Creating…' : 'Create invitation'}</button></>}>
          {link ? (
            <>
              <p>Send this private link to your teammate. It works once, for the invited email address, for seven days.</p>
              <input aria-label="Invitation link" readOnly value={link} onFocus={e => e.target.select()} />
            </>
          ) : (
            <form id="invite-form" className="form" onSubmit={invite}>
              <Field label="Email address" name="email" type="email" autoComplete="off" required />
              <Field label="Role" hint={ROLE_INFO.find(([r]) => r === newRole)[1]}>
                <select value={newRole} onChange={e => { setNewRole(e.target.value); setNewPages(ROLE_PAGES[e.target.value]); }}>
                  {ROLE_INFO.map(([r]) => <option key={r} value={r}>{r === 'Service' ? 'Service (cashier & floor)' : r}</option>)}
                </select>
              </Field>
              <PageChooser role={newRole} value={newPages} onChange={setNewPages} />
              <ErrorText>{error}</ErrorText>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
