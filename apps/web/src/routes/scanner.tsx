import { useState } from 'react'
import { Screen, TopBar } from '../components/redesign/chrome'
import { Card, Button } from '../components/redesign/ui'
import { BoxBoy } from '../components/redesign/brand'

export default function ScannerRoute(){
  const [log,setLog]=useState<string[]>([])
  return (
    <Screen>
      <TopBar title="Scan attendance" />
      <div style={{padding:16, display:'grid', gap:16}}>
        <Card tone="light">
          <div style={{display:'flex', gap:12, alignItems:'center'}}>
            <BoxBoy pose="teaching" width={80}/>
            <div>
              <h3 style={{margin:0, fontFamily:'var(--font-headline)'}}>Camera scan</h3>
              <p style={{color:'var(--u-text-2)', marginTop:4}}>Point at student pass</p>
            </div>
          </div>
        </Card>
        <div style={{height:300,borderRadius:24,background:'#1a1a1a',display:'flex',alignItems:'center',justifyContent:'center'}}>
          Camera placeholder
        </div>
        <Card tone="light">
          <ul style={{margin:0,paddingLeft:16}}>
            {log.map((l,i)=><li key={i}>{l}</li>)}
          </ul>
        </Card>
        <Button variant="amber" onClick={()=>setLog(l=>[...l,'Scanned'])}>Simulate scan</Button>
      </div>
    </Screen>
  )
}
