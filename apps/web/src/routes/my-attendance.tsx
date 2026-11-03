import { useEffect, useState } from 'react'
import { supabaseBrowser } from '../lib/supabase'

export default function MyAttendanceRoute(){
  const [rows,setRows]=useState<any[]>([])
  useEffect(()=>{
    const sb = supabaseBrowser()
    if(!sb) return
    sb.auth.getUser().then(async ({data:{user}})=>{
      if(!user) return
      const {data} = await sb.from('attendance_records').select('course_code,scanned_at').eq('student_id',user.id)
      setRows(data||[])
    })
  },[])
  return (
    <div style={{padding:24}}>
      <h1>My Attendance</h1>
      <ul>
        {rows.map(r=><li key={r.scanned_at}>{r.course_code} - {new Date(r.scanned_at).toLocaleDateString()}</li>)}
      </ul>
    </div>
  )
}
