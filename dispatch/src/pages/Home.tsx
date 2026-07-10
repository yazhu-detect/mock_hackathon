import { Link } from 'react-router-dom'
import './dispatch.css'

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

interface Card {
  to?: string
  neww?: boolean
  icon: React.ReactNode
  title: string
  desc: string
  tags: string[]
}

const cards: Card[] = [
  {
    to: '/dispatch',
    neww: true,
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="m9 16 2 2 4-4"></path></svg>),
    title: 'Threadr Dispatch',
    desc: 'Tell it the volume, get the schedule. Auto-assigns annotation and review work across analysts by throughput, accuracy, and turnaround — and coaches the team as it goes.',
    tags: ['AUTO-SCHEDULING', 'CONVERSATIONAL', 'ANALYST COACHING'],
  },
  {
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>),
    title: 'Threadr Classifier',
    desc: 'Swipe-style classification for image crops. Sort images into classes with keyboard shortcuts.',
    tags: ['BINARY CLASSIFICATION', 'KEYBOARD SHORTCUTS', 'REVIEW QUEUE'],
  },
  {
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="1.2" fill="#5C97FF"></circle><circle cx="15" cy="9" r="1.2" fill="#5C97FF"></circle><circle cx="9" cy="15" r="1.2" fill="#5C97FF"></circle><circle cx="15" cy="15" r="1.2" fill="#5C97FF"></circle></svg>),
    title: 'Threadr Detector',
    desc: 'Annotate full images using YOLO detection. Sub-classify each detection and export YOLO format labels.',
    tags: ['YOLO DETECTION', 'SUB-CLASSIFICATION', 'YOLO FORMAT EXPORT'],
  },
  {
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg>),
    title: 'Condition Assessment',
    desc: 'CSV-driven inspection workflow. Upload structures + image paths, run YOLO pre-detection, classify defects with severity, and review.',
    tags: ['CSV UPLOAD', 'ANNOTATION + REVIEW', 'REOPEN ON COMPLETE'],
  },
  {
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>),
    title: 'VLM Dataset Builder',
    desc: 'Build datasets for VLM finetuning. Classify images with classes and checklist reasons; an agent generates reasoning for export.',
    tags: ['CLASS + CHECKLIST', 'LLM REASONING', 'JSONL EXPORT'],
  },
  {
    icon: (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>),
    title: 'Learn',
    desc: 'Study domain knowledge from completed sessions. Browse examples with AI explanations and test yourself with quizzes.',
    tags: ['STUDY MODE', 'AI EXPLANATIONS', 'QUIZ MODE'],
  },
]

function CardInner({ c }: { c: Card }) {
  return (
    <>
      {c.neww && (<span style={{ position: 'absolute', top: 24, right: 24, padding: '4px 12px', borderRadius: 999, background: 'var(--volt-green)', color: '#14110F', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>NEW</span>)}
      <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--icon-blue-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{c.icon}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em' }}>{c.title}</div>
        <div style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--fg-muted)' }}>{c.desc}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 'auto' }}>
        {c.tags.map((t) => (<span key={t} style={{ padding: '5px 12px', borderRadius: 999, background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--fg-subtle)', fontSize: 11, letterSpacing: '0.06em' }}>{t}</span>))}
      </div>
    </>
  )
}

const cardStyle: React.CSSProperties = {
  position: 'relative', display: 'flex', flexDirection: 'column', gap: 20,
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
  padding: 32, color: 'var(--fg)', textDecoration: 'none',
  transition: 'border-color 120ms cubic-bezier(0.2,0.8,0.2,1), background 120ms cubic-bezier(0.2,0.8,0.2,1)',
}

export default function Home() {
  const iconBtns = [
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>,
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>,
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>,
  ]
  return (
    <div data-theme="dark" data-screen-label="Threadr Home" style={{ ['--app-bg' as any]: '#0B0C0E', ['--surface' as any]: '#151719', ['--surface-subtle' as any]: '#1C1F23', ['--surface-elevated' as any]: '#24272C', ['--surface-sunken' as any]: '#050607', ['--border' as any]: '#26292E', ['--border-strong' as any]: '#3A3E45', minHeight: '100vh', background: 'var(--app-bg)', color: 'var(--fg)', fontFamily: "'Instrument Sans', sans-serif" }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '24px 32px 0 32px' }}>
        {iconBtns.map((ic, i) => (
          <button key={i} className="dc-icon-btn" style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>{ic}</button>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '40px 24px 48px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 44, fontWeight: 500, letterSpacing: '-0.02em', color: 'var(--fg)' }}>Detect Threadr</h1>
        <button className="dc-pill-hover" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-muted)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 15, cursor: 'pointer' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="6"></circle><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"></path></svg>
          Leaderboard
        </button>
      </div>

      <div style={{ maxWidth: 940, margin: '0 auto', padding: '0 24px 80px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {cards.map((c) =>
          c.to ? (
            <Link key={c.title} to={c.to} className="dc-card-hover" style={cardStyle}><CardInner c={c} /></Link>
          ) : (
            <a key={c.title} href="#" className="dc-card-hover" style={cardStyle}><CardInner c={c} /></a>
          ),
        )}
      </div>
    </div>
  )
}
