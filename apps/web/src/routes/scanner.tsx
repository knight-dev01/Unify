import { useState } from 'react'
export default function ScannerRoute(){
  const [log,setLog]=useState<string[]>([])
  return (
    <div style={{padding:24}}>
      <h1>Scan attendance</h1>
      <div style={{height:300,borderRadius:24,background:'#1a1a1a',display:'flex',alignItems:'center',justifyContent:'center'}}>
        Camera placeholder
      </div>
      <ul>{log.map((l,i)=><li key={i}>{l}</li>)}</ul>
      <button onClick={()=>setLog(l=>[...l,'Scanned'])}>Simulate scan</button>
    </div>
  )
}
