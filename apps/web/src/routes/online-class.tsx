import { useState } from 'react'
export default function OnlineClassRoute(){
  const [checked,setChecked]=useState([true,false,false])
  return <div style={{padding:24}}><h1>Online Class</h1><p>Check-ins: {checked.filter(Boolean).length}/3</p><button onClick={()=>setChecked(c=>[...c,true])}>Simulate check-in</button></div>
}
