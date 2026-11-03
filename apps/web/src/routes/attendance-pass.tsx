import { useEffect, useState } from 'react'
import { supabaseBrowser } from '../lib/supabase'

export default function AttendancePassRoute() {
  const [seed, setSeed] = useState(1)
  const [left, setLeft] = useState(30)

  useEffect(()=>{
    const t = setInterval(()=> {
      setLeft(s=>{ if(s<=1){ setSeed(x=>x+1); return 30 } return s-1 })
    },1000)
    return ()=>clearInterval(t)
  },[])

  const PassCode = ({seed}:{seed:number})=>{
    const cells = Array.from({length:21*21},(_,i)=>((i*7919+seed*104729)%13)<6)
    return <div style={{display:'grid',gridTemplateColumns:'repeat(21,1fr)',width:220,height:220,background:'#fff',padding:10,borderRadius:16}}>
      {cells.map((on,i)=><span key={i} style={{background:on?'#0a0a0a':'#fff'}}/>)}
    </div>
  }

  return (
    <div style={{padding:24,display:'flex',flexDirection:'column',alignItems:'center',background:'#0a0a0a',color:'#fff',minHeight:'100vh'}}>
      <h2>Attendance pass</h2>
      <div style={{padding:12,borderRadius:24,background:'var(--u-green)' ,margin:'20px 0'}}><PassCode seed={seed}/></div>
      <p>New code in {left}s</p>
      <p style={{color:'#aaa'}}>Works without data · pass valid today</p>
    </div>
  )
}
