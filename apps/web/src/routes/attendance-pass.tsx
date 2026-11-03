import { useEffect, useState } from 'react'
import { supabaseBrowser } from '../lib/supabase'
import { Screen, TopBar } from '../components/redesign/chrome'
import { Card, Button } from '../components/redesign/ui'
import { BoxBoy } from '../components/redesign/brand'

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
      {cells.map((on,i)=><span key={i} style={{background:on?'#0a0a0a':'#fff',width:8,height:8}}/>)}
    </div>
  }

  return (
    <Screen>
      <TopBar title="Attendance pass" />
      <div style={{ padding: 16, display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
        <Card tone="dark" pad={24}>
          <div style={{ textAlign:'center', display:'grid', placeItems:'center', gap:12 }}>
            <BoxBoy pose="wavePhone" width={100}/>
            <PassCode seed={seed}/>
            <p style={{color:'var(--u-on-dark-2)'}}>New code in {left}s</p>
            <p style={{color:'var(--u-on-dark-2)'}}>Works without data · pass valid today</p>
          </div>
        </Card>
        <Button variant="amber" onClick={()=>{}}>Refresh</Button>
      </div>
    </Screen>
  )
}
