import { useState } from 'react'
export default function LecturerHome(){
  const [tab,setTab]=useState('home')
  return <div style={{padding:24}}>
    <h1>Lecturer</h1>
    <div style={{display:'flex',gap:8,margin:'16px 0'}}>
      {['home','timetable','course','actions','attendance','me'].map(t=><button key={t} onClick={()=>setTab(t)} style={{padding:'8px 12px',background:tab===t?'#fbbf24':'#eee'}}>{t}</button>)}
    </div>
    {tab==='home'&&<div>One main button: Confirm class / Open scan / Post materials</div>}
    {tab==='timetable'&&<div>Timetable view</div>}
    {tab==='course'&&<div>Weeks / Report / Attendance tabs</div>}
    {tab==='actions'&&<div>Review week / Send materials / Post to students</div>}
    {tab==='attendance'&&<div>Attendance list with export CSV</div>}
    {tab==='me'&&<div>Profile</div>}
  </div>
}
