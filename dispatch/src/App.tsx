import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Dispatch from './pages/Dispatch'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dispatch" element={<Dispatch />} />
    </Routes>
  )
}
