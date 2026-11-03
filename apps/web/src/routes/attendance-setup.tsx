import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabaseBrowser } from '../lib/supabase'
import { toastError, toastSuccess } from '../lib/toast'

export default function AttendanceSetupRoute() {
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [matric, setMatric] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!fullName || !matric) return toastError('Fill name and matric')
    setSaving(true)
    try {
      const sb = supabaseBrowser()
      if (!sb) throw new Error('Not authenticated')
      const { data: { user } } = await sb.auth.getUser()
      if (!user) throw new Error('Not authenticated')
      const { error } = await sb.from('profiles').update({
        attendance_full_name: fullName,
        attendance_matric: matric
      }).eq('id', user.id)
      if (error) throw error
      toastSuccess('Attendance set up')
      navigate('/attendance/pass')
    } catch (e: any) {
      toastError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 480, margin: '0 auto' }}>
      <h1>Attendance setup</h1>
      <p>This is for attendance. Heads of Class see this name when they scan your pass.</p>
      <label>Full name</label>
      <input value={fullName} onChange={e=>setFullName(e.target.value)} style={{ width:'100%', padding:8, margin:'8px 0' }} />
      <label>Matric number</label>
      <input value={matric} onChange={e=>setMatric(e.target.value)} style={{ width:'100%', padding:8, margin:'8px 0' }} />
      <button onClick={save} disabled={saving} style={{ padding:'10px 16px', marginTop:12 }}>{saving?'Saving...':'Save and get pass'}</button>
    </div>
  )
}
