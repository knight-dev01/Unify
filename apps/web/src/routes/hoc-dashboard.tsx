import { useState } from 'react'
export default function HocDashboard(){
  const [posts,setPosts]=useState([{id:1,title:'Announcement',content:'Welcome'}])
  return <div style={{padding:24}}><h1>Head of Class</h1><ul>{posts.map(p=><li key={p.id}>{p.title}: {p.content}</li>)}</ul></div>
}
