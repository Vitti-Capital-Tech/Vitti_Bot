import React, { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import { 
  Shield, 
  Activity, 
  Settings, 
  Terminal, 
  UserPlus, 
  Trash2, 
  Power, 
  RefreshCw, 
  DollarSign, 
  TrendingUp, 
  AlertTriangle, 
  Clock, 
  Sliders, 
  CheckCircle2, 
  AlertCircle,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Cpu,
  Layers,
  Lock,
  TrendingDown,
  Info
} from 'lucide-react'

export default function App() {
  // Database States
  const [accounts, setAccounts] = useState([])
  const [strategy, setStrategy] = useState(null)
  const [positions, setPositions] = useState([])
  const [logs, setLogs] = useState([])
  
  const [toasts, setToasts] = useState([])
  const [lastLogId, setLastLogId] = useState(null)
  const [showConfirmModal, setShowConfirmModal] = useState(null) // holds { ids, title, message } or null
  
  // UI states
  const [loading, setLoading] = useState(true)
  const [showAddAccountModal, setShowAddAccountModal] = useState(false)
  const [activeTab, setActiveTab] = useState('positions') // 'positions' | 'accounts' | 'config'
  const [consoleExpanded, setConsoleExpanded] = useState(false)
  
  // Add Account form states
  const [accName, setAccName] = useState('')
  const [accKey, setAccKey] = useState('')
  const [accSecret, setAccSecret] = useState('')
  const [accEnv, setAccEnv] = useState('testnet')
  
  // Refresh data trigger
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  // Terminal scroll reference
  const terminalEndRef = useRef(null)

  // Helper to trigger toast notification
  const showToast = (message, type = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4500)
  }

  // Fetch initial data
  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      try {
        // 1. Fetch Accounts
        const accs = await supabase.from('accounts').select('*').order('name')
        if (accs.data) setAccounts(accs.data)
        
        // 2. Fetch Strategy (decay1)
        const strat = await supabase.from('strategies').select('*').eq('name', 'decay1').single()
        if (strat.data) setStrategy(strat.data)
        
        // 3. Fetch Open Positions
        const pos = await supabase.from('positions').select('*').eq('status', 'open').order('created_at', { ascending: false })
        if (pos.data) setPositions(pos.data)
        
        // 4. Fetch Logs
        const lg = await supabase.from('trade_logs').select('*').order('created_at', { ascending: false }).limit(40)
        if (lg.data) {
          setLogs(lg.data)
          if (lg.data.length > 0) {
            const latestLog = lg.data[0]
            if (lastLogId === null) {
              setLastLogId(latestLog.id)
            } else if (latestLog.id !== lastLogId) {
              const lastIndex = lg.data.findIndex(l => l.id === lastLogId)
              const newLogs = lastIndex !== -1 ? lg.data.slice(0, lastIndex).reverse() : [latestLog]
              newLogs.forEach(newLog => {
                const type = newLog.log_level === 'TRADE' ? 'success' : (newLog.log_level === 'ERROR' ? 'error' : 'info')
                showToast(newLog.message, type)
              })
              setLastLogId(latestLog.id)
            }
          }
        }
      } catch (err) {
        console.error("Error fetching database records:", err)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [refreshTrigger, lastLogId])

  // Subscribe to real-time changes using Supabase Realtime Channels
  useEffect(() => {
    // 1. Realtime Positions
    const posChannel = supabase
      .channel('positions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, (payload) => {
        setRefreshTrigger(prev => prev + 1)
      })
      .subscribe()
      
    // 2. Realtime Logs
    const logChannel = supabase
      .channel('logs-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trade_logs' }, (payload) => {
        setLogs(prev => [payload.new, ...prev.slice(0, 39)])
      })
      .subscribe()
      
    // 3. Realtime Accounts
    const accChannel = supabase
      .channel('accounts-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, (payload) => {
        setRefreshTrigger(prev => prev + 1)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(posChannel)
      supabase.removeChannel(logChannel)
      supabase.removeChannel(accChannel)
    }
  }, [])

  // Backup Auto-Refresh Polling (Triggers full data sync every 5 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshTrigger(prev => prev + 1)
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // Auto-scroll terminal to bottom when logs change or console expands
  useEffect(() => {
    if (consoleExpanded && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, consoleExpanded])

  // Action Handlers
  const handleToggleAccount = async (id, is_active) => {
    try {
      await supabase.from('accounts').update({ is_active: !is_active }).eq('id', id)
      setRefreshTrigger(prev => prev + 1)
      showToast(`Account status updated.`, 'info')
    } catch (err) {
      console.error(err)
      showToast("Failed to toggle account.", 'error')
    }
  }

  const handleToggleStrategy = async () => {
    if (!strategy) return
    try {
      await supabase.from('strategies').update({ is_active: !strategy.is_active }).eq('id', strategy.id)
      setRefreshTrigger(prev => prev + 1)
      showToast(`Strategy Decay1 is now ${!strategy.is_active ? 'ENABLED' : 'PAUSED'}.`, !strategy.is_active ? 'success' : 'info')
    } catch (err) {
      console.error(err)
      showToast("Failed to toggle strategy.", 'error')
    }
  }

  const handleAddAccount = async (e) => {
    e.preventDefault()
    if (!accName || !accKey || !accSecret) return
    
    try {
      await supabase.from('accounts').insert({
        name: accName,
        api_key: accKey,
        api_secret: accSecret,
        env: accEnv,
        is_active: true
      })
      setShowAddAccountModal(false)
      setAccName('')
      setAccKey('')
      setAccSecret('')
      setRefreshTrigger(prev => prev + 1)
      showToast("New trading account linked successfully.", 'success')
    } catch (err) {
      console.error(err)
      showToast("Failed to add account.", 'error')
    }
  }

  const handleDeleteAccount = async (id) => {
    if (!window.confirm("Are you sure you want to remove this account?")) return
    try {
      await supabase.from('accounts').delete().eq('id', id)
      setRefreshTrigger(prev => prev + 1)
      showToast("Trading account deleted.", 'info')
    } catch (err) {
      console.error(err)
      showToast("Failed to delete account.", 'error')
    }
  }

  const handleUpdateConfig = async (e) => {
    e.preventDefault()
    const formData = new FormData(e.target)
    const sl = parseFloat(formData.get('sl_multiplier'))
    const entry = formData.get('entry_time')
    const exit = formData.get('exit_time')
    const tgt = parseFloat(formData.get('target_pct'))
    
    try {
      await supabase.from('strategies').update({
        sl_multiplier: sl,
        entry_time_ist: entry,
        exit_time_ist: exit,
        underlying_target_pct: tgt
      }).eq('id', strategy.id)
      showToast("Decay1 strategy parameters updated.", 'success')
      setRefreshTrigger(prev => prev + 1)
    } catch (err) {
      console.error(err)
      showToast("Failed to update strategy config.", 'error')
    }
  }

  // Trigger Confirmation Modal for Single Leg close
  const triggerLegClose = (posId, symbol) => {
    setShowConfirmModal({
      ids: [posId],
      title: "Confirm Strangle Leg Exit",
      message: `You are requesting an emergency square-off for option leg: ${symbol}. This will execute a market order to buy back the option contract.`
    })
  }

  // Trigger Confirmation Modal for Entire Strangle close
  const triggerStrangleClose = (positionsList, accountName) => {
    const ids = positionsList.map(p => p.id)
    setShowConfirmModal({
      ids,
      title: "Confirm Double Strangle Exit",
      message: `You are requesting a combined square-off for BOTH Call & Put legs in account [${accountName}]. This will dispatch concurrent market close orders to minimize slippage.`
    })
  }

  // Execute actual close requested
  const handleEmergencyClose = async () => {
    if (!showConfirmModal) return
    const { ids } = showConfirmModal
    try {
      setLoading(true)
      
      // Update each target position status to 'close_requested'
      for (const posId of ids) {
        await supabase.from('positions').update({ 
          status: 'close_requested'
        }).eq('id', posId)
      }
      
      // Insert unified event log for the dashboard/daemon
      await supabase.from('trade_logs').insert({
        account_name: 'SYSTEM',
        strategy_name: 'decay1',
        message: `Dashboard emergency close triggered for position(s): ${ids.join(', ')}`,
        log_level: 'INFO'
      })
      
      setShowConfirmModal(null)
      setRefreshTrigger(prev => prev + 1)
      showToast(ids.length > 1 ? "Strangle double close dispatched." : "Leg close requested.", 'info')
    } catch (err) {
      console.error(err)
      showToast("Close request failed.", 'error')
    } finally {
      setLoading(false)
    }
  }

  // Helper to parse option symbols (Format: C-BTC-90000-310125)
  const parseOptionSymbol = (symbol) => {
    const parts = symbol.split('-')
    if (parts.length === 4) {
      return {
        type: parts[0],        // 'C' or 'P'
        underlying: parts[1],  // 'BTC'
        strike: parseFloat(parts[2]),
        expiry: parts[3]       // '310125'
      }
    }
    const isCall = symbol.startsWith('C-')
    return {
      type: isCall ? 'C' : 'P',
      underlying: 'BTC',
      strike: 0,
      expiry: ''
    }
  }

  // Calculate live unrealized PnL summary
  const totalPnL = positions.reduce((acc, pos) => acc + (parseFloat(pos.pnl) || 0.0), 0.0)

  // Group positions by Account ID to render consolidated Strangles
  const getGroupedStrangles = () => {
    const groups = {}
    positions.forEach(pos => {
      if (!groups[pos.account_id]) {
        groups[pos.account_id] = []
      }
      groups[pos.account_id].push(pos)
    })

    return Object.keys(groups).map(accId => {
      const accDetails = accounts.find(a => a.id === accId) || { name: 'Linked Account', env: 'production' }
      const accPosList = groups[accId]
      
      // Separate into Call and Put legs
      const calls = accPosList.filter(p => p.symbol.startsWith('C-'))
      const puts = accPosList.filter(p => p.symbol.startsWith('P-'))

      // Strangle Pairs
      const stranglePairs = []
      const unpaired = []

      // Simple matching based on expiry (or nearest strike)
      const usedPuts = new Set()
      
      calls.forEach(c => {
        const cParsed = parseOptionSymbol(c.symbol)
        // Find matching put from same expiry
        const matchingPut = puts.find(p => {
          if (usedPuts.has(p.id)) return false
          const pParsed = parseOptionSymbol(p.symbol)
          return pParsed.expiry === cParsed.expiry
        })

        if (matchingPut) {
          stranglePairs.push({ call: c, put: matchingPut })
          usedPuts.add(matchingPut.id)
        } else {
          unpaired.push(c)
        }
      })

      // Collect puts that didn't pair up
      puts.forEach(p => {
        if (!usedPuts.has(p.id)) {
          unpaired.push(p)
        }
      })

      return {
        accountId: accId,
        accountName: accDetails.name,
        env: accDetails.env,
        stranglePairs,
        unpaired
      }
    })
  }

  const groupedStrangles = getGroupedStrangles()

  // Calculate Active Strangle accounts
  const activeStrangleAccountsCount = groupedStrangles.filter(g => g.stranglePairs.length > 0 || g.unpaired.length > 0).length

  // Determine daemon health status: check if we received logs within last 5 minutes
  const isDaemonHealthy = () => {
    if (logs.length === 0) return false
    const latestLogTime = new Date(logs[0].created_at)
    const differenceInMinutes = (new Date() - latestLogTime) / (1000 * 60)
    return differenceInMinutes < 10 // Healthy if a log event happened in last 10 mins (including bot heartbeats)
  }

  return (
    <div className="min-h-screen bg-[#05070e] text-gray-200 flex flex-col font-sans relative overflow-hidden pb-16">
      
      {/* Decorative High-End Blur Orbs */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-[140px] pointer-events-none"></div>
      <div className="absolute top-1/4 right-1/4 w-[600px] h-[600px] bg-indigo-500/5 rounded-full blur-[180px] pointer-events-none"></div>
      <div className="absolute bottom-10 left-10 w-96 h-96 bg-emerald-500/[0.02] rounded-full blur-3xl pointer-events-none"></div>
      
      {/* TOP SYSTEM STATUS BAR */}
      <div className="bg-[#0b0f19]/80 border-b border-white/[0.04] backdrop-blur-md px-6 py-2.5 text-xs text-gray-400 font-medium">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${isDaemonHealthy() ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'} shadow-[0_0_8px_#10b981]`}></span>
              <span className="text-[10px] font-bold tracking-wider uppercase text-gray-300">
                Execution Daemon: {isDaemonHealthy() ? 'ONLINE' : 'STANDBY (NO RECENT HEARTBEATS)'}
              </span>
            </span>
            <span className="text-gray-600 hidden sm:inline">|</span>
            <span className="flex items-center gap-1.5 text-gray-500 font-mono text-[10px]">
              <Clock className="w-3.5 h-3.5 text-cyan-400" />
              IST TIMEZONE: (GMT+5:30)
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[9px] bg-cyan-950/40 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded font-bold uppercase tracking-wider">
              V2 Intraday Signed Client
            </span>
            <span className="text-[9px] bg-[#111827] text-gray-400 border border-white/5 px-2 py-0.5 rounded font-mono">
              Demo Testnet Enabled
            </span>
          </div>
        </div>
      </div>

      {/* MAIN HEADER NAVBAR */}
      <header className="border-b border-white/5 bg-[#070a13]/60 sticky top-0 z-40 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4.5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500/10 to-indigo-500/10 border border-cyan-500/20 flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.15)] animate-float">
              <Shield className="w-6 h-6 text-cyan-400 drop-shadow-[0_0_6px_rgba(6,182,212,0.5)]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-white font-['Space_Grotesk'] bg-clip-text text-transparent bg-gradient-to-r from-white via-gray-200 to-cyan-400">
                  DeltaTrade
                </h1>
                <span className="text-[8px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.2 rounded font-bold tracking-widest uppercase">PRO</span>
              </div>
              <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">Automated Intraday Option Strangle Desk</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Global Strategy Status Toggler */}
            {strategy && (
              <button 
                onClick={handleToggleStrategy}
                className={`flex items-center gap-2.5 px-4.5 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all duration-300 ${
                  strategy.is_active 
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.08)] hover:bg-emerald-500/20' 
                  : 'bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-[0_0_15px_rgba(239,68,68,0.08)] hover:bg-rose-500/20'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${strategy.is_active ? 'bg-emerald-400 animate-ping' : 'bg-rose-400'} mr-0.5`}></span>
                Decay1: {strategy.is_active ? 'Active' : 'Paused'}
              </button>
            )}
            
            <button 
              onClick={() => {
                setRefreshTrigger(prev => prev + 1)
                showToast("Manual data sync complete.", 'info')
              }}
              className="p-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.08] border border-white/5 hover:border-white/10 transition duration-200"
              title="Sync Data"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : 'text-gray-400'}`} />
            </button>
          </div>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 flex flex-col gap-8 z-10">
        
        {/* KPI INSTITUTIONAL METRICS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Performance Box */}
          <div className="glass-panel rounded-2xl p-6 relative overflow-hidden border-t-2 border-cyan-500/60 hover:-translate-y-0.5 transition-all duration-300 glow-cyan-subtle">
            <div className="absolute right-3 bottom-3 opacity-[0.03] pointer-events-none">
              <DollarSign className="w-28 h-28 text-white" />
            </div>
            <div className="flex justify-between items-start">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-mono">Unrealized Performance</p>
              <span className={`text-[9px] px-2 py-0.5 rounded-md font-extrabold tracking-wider border ${
                totalPnL >= 0 
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
              }`}>
                {totalPnL >= 0 ? 'PROFIT' : 'DRAWDOWN'}
              </span>
            </div>
            <h3 className={`text-3xl font-extrabold mt-3 tracking-tight font-mono ${
              totalPnL >= 0 
              ? 'text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.2)]' 
              : 'text-rose-400 drop-shadow-[0_0_12px_rgba(239,68,68,0.2)]'
            }`}>
              {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(4)} <span className="text-sm font-bold text-gray-400">USDT</span>
            </h3>
            <div className="mt-4 flex items-center gap-1.5 text-[10px] text-gray-500 font-medium">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>Real-time consolidated options strangle yield</span>
            </div>
          </div>
          
          {/* Active Workspaces Box */}
          <div className="glass-panel rounded-2xl p-6 relative overflow-hidden border-t-2 border-indigo-500/60 hover:-translate-y-0.5 transition-all duration-300">
            <div className="absolute right-3 bottom-3 opacity-[0.03] pointer-events-none">
              <Layers className="w-28 h-28 text-white" />
            </div>
            <div className="flex justify-between items-start">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-mono">Live Strangle Pairs</p>
              <span className="text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-md font-bold tracking-wider font-mono">
                {activeStrangleAccountsCount} ACCOUNTS
              </span>
            </div>
            <h3 className="text-3xl font-extrabold mt-3 text-white tracking-tight font-mono">
              {positions.length} <span className="text-sm font-semibold text-gray-400">Option Legs</span>
            </h3>
            <div className="mt-4 flex items-center gap-1.5 text-[10px] text-gray-500 font-medium">
              <Cpu className="w-3.5 h-3.5 text-indigo-400" />
              <span>Simultaneous strangle monitoring at Delta Exchange</span>
            </div>
          </div>

          {/* Strategy Details Box */}
          <div className="glass-panel rounded-2xl p-6 relative overflow-hidden border-t-2 border-amber-500/60 hover:-translate-y-0.5 transition-all duration-300">
            <div className="absolute right-3 bottom-3 opacity-[0.03] pointer-events-none">
              <Sliders className="w-28 h-28 text-white" />
            </div>
            <div className="flex justify-between items-start">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-mono">Short Strangle Setup</p>
              <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-md font-bold tracking-wider">
                DECAY1
              </span>
            </div>
            <h3 className="text-3xl font-extrabold mt-3 text-cyan-400 tracking-tight font-mono">
              {strategy ? strategy.strike_selection.toUpperCase() : 'OTM6'}
            </h3>
            <div className="mt-4 flex items-center gap-1.5 text-[10px] text-gray-500 font-medium">
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>08:31 IST Entry • 12:29 IST Hard Exit</span>
            </div>
          </div>
        </div>

        {/* MAIN CONSOLE PANEL */}
        <div className="glass-panel rounded-2xl bg-[#090d18]/45 backdrop-blur-2xl border border-white/5 overflow-hidden flex flex-col min-h-[500px] shadow-2xl">
          
          {/* Sleek Horizontal Tab List */}
          <div className="flex border-b border-white/[0.04] bg-[#070b13]/80 px-4 pt-3.5 gap-1.5">
            {[
              { id: 'positions', label: 'Active Strangles', icon: Activity },
              { id: 'accounts', label: 'Trading Accounts', icon: UserPlus },
              { id: 'config', label: 'Decay1 Parameters', icon: Sliders }
            ].map(tab => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2.5 px-6 py-4 text-xs font-bold uppercase tracking-wider rounded-t-xl transition-all duration-300 relative focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 ${
                    isActive 
                    ? 'bg-[#0b101c]/70 text-white border-t border-x border-white/5 shadow-inner' 
                    : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <tab.icon className={`w-4 h-4 transition-colors duration-300 ${isActive ? 'text-cyan-400' : 'text-gray-500'}`} />
                  {tab.label}
                  <span className={`absolute bottom-0 left-6 right-6 h-0.5 bg-gradient-to-r from-cyan-400 to-indigo-500 rounded-full shadow-[0_0_12px_#06b6d4] transition-all duration-300 transform origin-center ${
                    isActive ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-50'
                  }`}></span>
                </button>
              )
            })}
          </div>

          {/* TAB SHEETS */}
          <div className="p-8 flex-1 bg-white/[0.01] relative min-h-[500px]">
            
            {/* POSITIONS & STRANGLE WORKSPACE */}
            <div className={`transition-all duration-350 ease-in-out transform flex flex-col gap-8 ${
              activeTab === 'positions' 
              ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
              : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-8 top-8 z-0'
            }`}>
                {positions.length === 0 ? (
                  /* INSTITUTIONAL STANDBY WORKSPACE */
                  <div className="flex flex-col lg:flex-row gap-8 items-center lg:items-stretch py-8">
                    
                    {/* Standby Banner */}
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 rounded-2xl bg-white/[0.01] border border-white/5">
                      <div className="w-16 h-16 rounded-full bg-cyan-500/5 border border-cyan-500/10 flex items-center justify-center text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.05)] mb-4 animate-pulse">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <h4 className="text-xl font-bold text-white font-['Space_Grotesk'] tracking-wide">Strangle Execution Idle</h4>
                      <p className="text-xs text-gray-500 mt-2.5 max-w-md leading-relaxed">
                        There are no active options strangle positions currently open on Delta Exchange. The scheduling daemon is actively awaiting the intraday strategy triggers.
                      </p>
                      <div className="mt-6 flex flex-wrap gap-2.5 justify-center">
                        <span className="text-[10px] font-mono bg-[#0b0f19] border border-white/5 text-cyan-400 px-3 py-1.5 rounded-lg font-bold">
                          NEXT INTRADAY ENTRY: 08:31 AM IST
                        </span>
                        <button 
                          onClick={() => setRefreshTrigger(prev => prev + 1)}
                          className="text-[10px] bg-white/5 hover:bg-white/10 text-gray-300 px-3 py-1.5 rounded-lg font-bold uppercase transition-all"
                        >
                          Manual Polling Sync
                        </button>
                      </div>
                    </div>

                    {/* Decay1 Strategy Mechanics Blueprint */}
                    <div className="w-full lg:w-[420px] glass-card rounded-2xl p-6 flex flex-col justify-between border border-white/5">
                      <div>
                        <div className="flex items-center gap-2 border-b border-white/5 pb-3">
                          <BookOpen className="w-4 h-4 text-amber-400" />
                          <h4 className="text-xs font-bold uppercase tracking-wider text-gray-300 font-mono">Strategy Specifications</h4>
                        </div>
                        
                        <div className="mt-4 flex flex-col gap-3 text-xs text-gray-400">
                          <div className="flex justify-between items-center py-1.5 border-b border-white/[0.02]">
                            <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5 text-gray-500" /> Contract Strike Selection</span>
                            <span className="font-mono font-bold text-white uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded text-[10px]">
                              OTM6 (Delta ~0.07)
                            </span>
                          </div>
                          
                          <div className="flex justify-between items-center py-1.5 border-b border-white/[0.02]">
                            <span className="flex items-center gap-1.5"><TrendingDown className="w-3.5 h-3.5 text-gray-500" /> Leg-wise Hard Stop Loss</span>
                            <span className="font-mono font-bold text-white bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-0.5 rounded text-[10px]">
                              +40.0% (1.40x Entry)
                            </span>
                          </div>

                          <div className="flex justify-between items-center py-1.5 border-b border-white/[0.02]">
                            <span className="flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-gray-500" /> Spot target exit</span>
                            <span className="font-mono font-bold text-white bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px]">
                              0.75% Spot Move (Exit Both)
                            </span>
                          </div>

                          <div className="flex justify-between items-center py-1.5">
                            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-gray-500" /> Active Session Duration</span>
                            <span className="font-mono font-bold text-white text-[10px]">
                              08:31 IST to 12:29 IST
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-6 bg-[#0b0f19]/80 p-3.5 rounded-xl border border-white/5 flex gap-3 items-start">
                        <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-gray-500 leading-relaxed">
                          Intraday option decay relies on selling options when volatility cools. The bot constantly monitors price every 10 seconds.
                        </p>
                      </div>
                    </div>

                  </div>
                ) : (
                  /* PREMIUM STRANGLE PAIR WORKSPACE */
                  <div className="flex flex-col gap-8">
                    
                    {groupedStrangles.map(group => {
                      const hasActiveStrangle = group.stranglePairs.length > 0 || group.unpaired.length > 0
                      if (!hasActiveStrangle) return null

                      return (
                        <div key={group.accountId} className="glass-card rounded-2xl border border-white/5 bg-[#0d1222]/30 p-6 flex flex-col gap-6 shadow-xl relative overflow-hidden">
                          
                          {/* Top Header Row of Account workspace */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-white/5 pb-4 gap-3">
                            <div className="flex items-center gap-3">
                              <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 font-mono text-[10px] font-bold">
                                STRANGLE SET
                              </div>
                              <div>
                                <h4 className="font-bold text-white font-['Space_Grotesk'] text-lg tracking-tight">{group.accountName}</h4>
                                <span className={`text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 border rounded-md mt-1 inline-block ${
                                  group.env === 'production' 
                                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                  : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.05)]'
                                }`}>
                                  {group.env === 'production' ? 'PROD - REAL FUNDS' : 'SANDBOX TESTNET'}
                                </span>
                              </div>
                            </div>
                            
                            {/* Strangle Double Exit Panel */}
                            <div className="flex items-center gap-3 self-end sm:self-auto">
                              <button
                                onClick={() => triggerStrangleClose([...group.stranglePairs.flatMap(p => [p.call, p.put]), ...group.unpaired], group.accountName)}
                                className="px-5 py-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-600 text-rose-400 hover:text-white border border-rose-500/20 hover:border-rose-600 hover:shadow-[0_0_15px_rgba(239,68,68,0.3)] text-[10px] font-extrabold uppercase tracking-wider transition-all duration-300"
                              >
                                Square Off Strangle (Both Legs)
                              </button>
                            </div>
                          </div>

                          {/* 1. Unified Strangle Pairs */}
                          {group.stranglePairs.map((pair, idx) => {
                            const callEntry = parseFloat(pair.call.entry_price) || 0
                            const putEntry = parseFloat(pair.put.entry_price) || 0
                            const callMark = parseFloat(pair.call.mark_price) || 0
                            const putMark = parseFloat(pair.put.mark_price) || 0
                            
                            const entrySum = callEntry + putEntry
                            const markSum = callMark + putMark
                            
                            const callPnL = parseFloat(pair.call.pnl) || 0
                            const putPnL = parseFloat(pair.put.pnl) || 0
                            const pairPnL = callPnL + putPnL

                            // Decay decay percentage: ((Entry - Mark) / Entry) * 100
                            // 100% means premium decayed to 0 (max profit).
                            // Negative percent means premium inflated (loss).
                            const decayPct = entrySum > 0 ? ((entrySum - markSum) / entrySum) * 100 : 0
                            
                            return (
                              <div key={idx} className="flex flex-col gap-6 bg-black/15 p-5 rounded-2xl border border-white/[0.03]">
                                
                                {/* Unified Premium Stats */}
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
                                  <div className="bg-[#080b13]/80 p-3 rounded-xl border border-white/5">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Entry Value</p>
                                    <p className="text-sm font-extrabold text-white mt-1">{entrySum.toFixed(4)} USDT</p>
                                  </div>
                                  <div className="bg-[#080b13]/80 p-3 rounded-xl border border-white/5">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Current Mark</p>
                                    <p className="text-sm font-extrabold text-gray-400 mt-1">{markSum.toFixed(4)} USDT</p>
                                  </div>
                                  <div className="bg-[#080b13]/80 p-3 rounded-xl border border-white/5">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Pair PnL</p>
                                    <p className={`text-sm font-extrabold mt-1 ${pairPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                      {pairPnL >= 0 ? '+' : ''}{pairPnL.toFixed(4)} USDT
                                    </p>
                                  </div>
                                  <div className="bg-[#080b13]/80 p-3 rounded-xl border border-white/5">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Premium Decayed</p>
                                    <p className={`text-sm font-extrabold mt-1 ${decayPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                      {decayPct.toFixed(2)}%
                                    </p>
                                  </div>
                                </div>

                                {/* PREMIUM DECAY VISUAL PROGRESS METER */}
                                <div className="flex flex-col gap-2 font-mono text-[9px] text-gray-500 font-bold uppercase tracking-wider">
                                  <div className="flex justify-between items-center">
                                    <span>Premium Inflation (Loss Zone)</span>
                                    <span className="text-cyan-400">Entry Level</span>
                                    <span>Optimal Premium Decay (Max profit: 100%)</span>
                                  </div>
                                  
                                  <div className="h-2.5 rounded-full bg-[#05070e] overflow-hidden relative border border-white/5">
                                    {decayPct < 0 ? (
                                      /* Loss Zone (Bar expands leftwards from the center / red zone) */
                                      <div 
                                        className="absolute right-1/2 h-full bg-gradient-to-l from-rose-500 to-rose-700/60 rounded-l-full transition-all duration-300 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                                        style={{ width: `${Math.min(Math.abs(decayPct) / 2, 50)}%` }}
                                      ></div>
                                    ) : (
                                      /* Profit Zone (Bar expands rightwards from the center / emerald zone) */
                                      <div 
                                        className="absolute left-1/2 h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-r-full transition-all duration-300 shadow-[0_0_10px_#10b981]"
                                        style={{ width: `${Math.min(decayPct / 2, 50)}%` }}
                                      ></div>
                                    )}
                                    {/* Middle Entry Level Indicator line */}
                                    <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-cyan-400 shadow-[0_0_8px_#22d3ee] z-20"></div>
                                  </div>
                                </div>

                                {/* Split Side-by-Side Leg view */}
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-2">
                                  
                                  {/* Call Leg Details */}
                                  {[pair.call, pair.put].map((leg, lIdx) => {
                                    const isCall = leg.symbol.startsWith('C-')
                                    const legPnL = parseFloat(leg.pnl) || 0
                                    const legParsed = parseOptionSymbol(leg.symbol)
                                    
                                    return (
                                      <div key={lIdx} className={`p-4 rounded-xl border relative overflow-hidden bg-white/[0.01] ${
                                        isCall 
                                        ? 'border-amber-500/10 hover:border-amber-500/20' 
                                        : 'border-indigo-500/10 hover:border-indigo-500/20'
                                      }`}>
                                        
                                        {/* Background icon indicator */}
                                        <div className="absolute right-2 bottom-0 opacity-[0.01] pointer-events-none font-bold font-mono text-7xl select-none">
                                          {isCall ? 'C' : 'P'}
                                        </div>

                                        <div className="flex justify-between items-center border-b border-white/5 pb-2.5">
                                          <div className="flex items-center gap-2">
                                            <span className="font-extrabold text-white text-sm font-mono tracking-tight">{leg.symbol}</span>
                                            <span className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest ${
                                              isCall 
                                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' 
                                              : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                            }`}>
                                              {isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                            </span>
                                          </div>
                                          
                                          <span className={`font-mono text-xs font-bold ${legPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {legPnL >= 0 ? '+' : ''}{legPnL.toFixed(4)} USDT
                                          </span>
                                        </div>

                                        <div className="grid grid-cols-3 gap-3 mt-3.5 text-[10px] font-mono text-gray-500 font-bold uppercase">
                                          <div>
                                            <p className="font-sans">Option Strike</p>
                                            <p className="text-white text-xs mt-1">${legParsed.strike.toLocaleString()}</p>
                                          </div>
                                          <div>
                                            <p className="font-sans">Leg Contract Size</p>
                                            <p className="text-gray-300 text-xs mt-1">{leg.size} Cont</p>
                                          </div>
                                          <div>
                                            <p className="font-sans">Stop Loss Boundary</p>
                                            <p className="text-rose-400 text-xs mt-1">${parseFloat(leg.sl_price || 0).toFixed(2)}</p>
                                          </div>
                                          <div>
                                            <p className="font-sans">Entry Price</p>
                                            <p className="text-gray-400 text-xs mt-1">${parseFloat(leg.entry_price).toFixed(2)}</p>
                                          </div>
                                          <div>
                                            <p className="font-sans">Mark Price</p>
                                            <p className="text-cyan-400 text-xs mt-1">${parseFloat(leg.mark_price || 0).toFixed(2)}</p>
                                          </div>
                                          <div className="flex items-end justify-end">
                                            <button
                                              onClick={() => triggerLegClose(leg.id, leg.symbol)}
                                              className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/25 transition-all text-[8px] font-bold uppercase tracking-wider"
                                            >
                                              Exit Leg
                                            </button>
                                          </div>
                                        </div>

                                      </div>
                                    )
                                  })}

                                </div>

                              </div>
                            )
                          })}

                          {/* 2. Unpaired Single Legs */}
                          {group.unpaired.length > 0 && (
                            <div className="flex flex-col gap-4">
                              <p className="text-[10px] text-gray-500 font-mono font-bold uppercase tracking-widest border-b border-white/5 pb-2">
                                Single Unpaired Option Legs (Stopped or Orphaned)
                              </p>
                              
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                {group.unpaired.map((leg, idx) => {
                                  const isCall = leg.symbol.startsWith('C-')
                                  const legPnL = parseFloat(leg.pnl) || 0
                                  const legParsed = parseOptionSymbol(leg.symbol)

                                  return (
                                    <div key={idx} className="p-4 rounded-xl border bg-[#1c0f16]/10 border-rose-500/10 hover:border-rose-500/25 transition relative overflow-hidden">
                                      <div className="flex justify-between items-center border-b border-white/5 pb-2">
                                        <div className="flex items-center gap-2">
                                          <span className="font-extrabold text-white text-sm font-mono tracking-tight">{leg.symbol}</span>
                                          <span className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest ${
                                            isCall ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                          }`}>
                                            {isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                          </span>
                                        </div>
                                        
                                        <span className={`font-mono text-xs font-bold ${legPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                          {legPnL >= 0 ? '+' : ''}{legPnL.toFixed(4)} USDT
                                        </span>
                                      </div>

                                      <div className="grid grid-cols-3 gap-3 mt-3 text-[10px] font-mono text-gray-500 font-bold uppercase">
                                        <div>
                                          <p className="font-sans">Strike</p>
                                          <p className="text-white text-xs mt-1">${legParsed.strike.toLocaleString()}</p>
                                        </div>
                                        <div>
                                          <p className="font-sans">Size</p>
                                          <p className="text-gray-300 text-xs mt-1">{leg.size} Cont</p>
                                        </div>
                                        <div>
                                          <p className="font-sans">SL Trigger</p>
                                          <p className="text-rose-400 text-xs mt-1">${parseFloat(leg.sl_price || 0).toFixed(2)}</p>
                                        </div>
                                        <div>
                                          <p className="font-sans">Entry Price</p>
                                          <p className="text-gray-400 text-xs mt-1">${parseFloat(leg.entry_price).toFixed(2)}</p>
                                        </div>
                                        <div>
                                          <p className="font-sans">Mark Price</p>
                                          <p className="text-cyan-400 text-xs mt-1">${parseFloat(leg.mark_price || 0).toFixed(2)}</p>
                                        </div>
                                        <div className="flex items-end justify-end">
                                          <button
                                            onClick={() => triggerLegClose(leg.id, leg.symbol)}
                                            className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/30 transition text-[8px] font-bold uppercase tracking-wider"
                                          >
                                            Square Off
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                        </div>
                      )
                    })}
                    
                  </div>
                )}
              </div>

            {/* TRADING ACCOUNTS */}
            <div className={`transition-all duration-350 ease-in-out transform flex flex-col gap-6 ${
              activeTab === 'accounts' 
              ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
              : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-8 top-8 z-0'
            }`}>
                
                <div className="flex flex-col sm:flex-row justify-between sm:items-center border-b border-white/[0.04] pb-4.5 gap-3">
                  <div>
                    <h3 className="text-base font-bold text-white font-['Space_Grotesk'] tracking-wide">Linked API Credentials</h3>
                    <p className="text-xs text-gray-500">Secure execution layers connecting to Delta Exchange API portal.</p>
                  </div>
                  
                  <button 
                    onClick={() => setShowAddAccountModal(true)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 to-indigo-500 hover:brightness-110 text-black text-xs font-bold uppercase tracking-wider transition-all duration-300 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                  >
                    <UserPlus className="w-4.5 h-4.5" />
                    Link New Account
                  </button>
                </div>

                {accounts.length === 0 ? (
                  <div className="text-center py-20 border border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                    <AlertCircle className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                    <h4 className="text-sm font-bold text-gray-400">No trading accounts associated</h4>
                    <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto leading-relaxed">
                      Add a sandbox keyset or live trade client secret to deploy the automated short strangle bot engine.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {accounts.map(acc => {
                      const accPositions = positions.filter(p => p.account_id === acc.id)
                      
                      return (
                        <div key={acc.id} className="glass-card rounded-2xl p-6 flex flex-col justify-between border border-white/5 hover:border-cyan-500/10 transition-all duration-300 relative overflow-hidden">
                          
                          {/* Colored Environment Strip */}
                          <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
                            acc.env === 'production' 
                            ? 'from-amber-400 to-amber-600' 
                            : 'from-cyan-400 to-indigo-500'
                          }`}></div>

                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-extrabold text-white text-lg tracking-tight font-['Space_Grotesk']">{acc.name}</h4>
                              <div className="flex gap-1.5 mt-2.5">
                                <span className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest border ${
                                  acc.env === 'production' 
                                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                  : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.05)]'
                                }`}>
                                  {acc.env === 'production' ? 'Production (Live)' : 'Testnet (Demo)'}
                                </span>
                                <span className="px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest border bg-white/5 text-gray-400 border-white/5">
                                  {accPositions.length} open position(s)
                                </span>
                              </div>
                              
                              <div className="mt-5 font-mono text-[9px] text-gray-500 font-bold uppercase tracking-wider">
                                <p>API Sign Key:</p>
                                <code className="text-[10px] text-cyan-400/80 bg-cyan-950/20 px-2.5 py-1.5 rounded-lg border border-cyan-500/10 inline-block mt-1 font-mono">
                                  ...{acc.api_key.slice(-12)}
                                </code>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={() => handleToggleAccount(acc.id, acc.is_active)}
                                className={`p-2.5 rounded-xl border transition-all duration-300 ${
                                  acc.is_active 
                                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25 shadow-[0_0_12px_rgba(16,185,129,0.12)]' 
                                  : 'bg-white/[0.01] text-gray-500 border-white/5'
                                }`}
                                title={acc.is_active ? 'Disable Account Execution' : 'Enable Account Execution'}
                              >
                                <Power className="w-4 h-4" />
                              </button>
                              
                              <button 
                                onClick={() => handleDeleteAccount(acc.id)}
                                className="p-2.5 rounded-xl bg-rose-500/5 hover:bg-rose-500/20 text-rose-400 border border-rose-500/10 hover:border-rose-500/30 transition-all duration-300"
                                title="Remove Credentials"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

            {/* STRATEGY PARAMETERS */}
            {strategy && (
              <form 
                onSubmit={handleUpdateConfig} 
                className={`transition-all duration-350 ease-in-out transform flex flex-col gap-6 max-w-2xl bg-black/10 p-6 rounded-2xl border border-white/5 ${
                  activeTab === 'config' 
                  ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
                  : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-8 top-8 z-0'
                }`}
              >
                
                <div className="border-b border-white/[0.04] pb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-white font-['Space_Grotesk'] tracking-wide">Decay1 Option Parameters</h3>
                    <p className="text-xs text-gray-500">Fine-tune decay boundaries and underlying asset guard rails.</p>
                  </div>
                  <span className="text-[10px] bg-[#0c101d] text-cyan-400 font-mono border border-cyan-500/20 px-2.5 py-1 rounded-md font-bold uppercase tracking-wider">
                    RE-BALANCES EVERY 10S
                  </span>
                </div>
                
                {/* Time range parameters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-mono">Entry Time (IST)</label>
                      <span className="text-[9px] text-gray-500 font-medium">Strangle placed on Exchange</span>
                    </div>
                    <input 
                      type="text" 
                      name="entry_time" 
                      defaultValue={strategy.entry_time_ist} 
                      className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono font-bold"
                    />
                  </div>
                  
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-mono">Exit Time (IST)</label>
                      <span className="text-[9px] text-gray-500 font-medium">Hard session square off</span>
                    </div>
                    <input 
                      type="text" 
                      name="exit_time" 
                      defaultValue={strategy.exit_time_ist} 
                      className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono font-bold"
                    />
                  </div>
                </div>

                {/* Risk boundaries */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-mono">Stop Loss (SL) Multiplier</label>
                      <span className="text-[9px] text-rose-400 font-bold uppercase tracking-wider bg-rose-500/5 px-2 rounded border border-rose-500/10 font-mono">
                        {((strategy.sl_multiplier - 1) * 100).toFixed(0)}% SL Leg limit
                      </span>
                    </div>
                    <input 
                      type="number" 
                      step="0.05"
                      name="sl_multiplier" 
                      defaultValue={strategy.sl_multiplier} 
                      className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono font-bold"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-mono">Favorable Spot Target (%)</label>
                      <span className="text-[9px] text-emerald-400 font-bold uppercase tracking-wider bg-emerald-500/5 px-2 rounded border border-emerald-500/10 font-mono">
                        {(strategy.underlying_target_pct * 100).toFixed(2)}% Spot Move Limit
                      </span>
                    </div>
                    <input 
                      type="number" 
                      step="0.0005"
                      name="target_pct" 
                      defaultValue={strategy.underlying_target_pct} 
                      className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono font-bold"
                    />
                  </div>
                </div>

                {/* Info and save */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-mono">Monitored Underlying Index</label>
                  <input 
                    type="text" 
                    disabled
                    defaultValue={strategy.underlying} 
                    className="bg-[#070b13] border border-white/5 rounded-xl px-4 py-3 text-sm text-gray-500 font-extrabold focus:outline-none cursor-not-allowed font-mono tracking-widest"
                  />
                </div>

                <div className="bg-cyan-500/5 p-4 rounded-xl border border-cyan-500/10 flex gap-3 items-start mt-2">
                  <Info className="w-5.5 h-5.5 text-cyan-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-gray-400 leading-relaxed">
                    <p className="font-bold text-gray-300">Intraday Safety Protections Actively Armed:</p>
                    <p className="mt-1">
                      1. Hard Intraday time exit halts strangle positions at **{strategy.exit_time_ist} IST** to prevent overnight gap risks.
                    </p>
                    <p className="mt-0.5">
                      2. If underlying index shifts by **{(strategy.underlying_target_pct * 100).toFixed(2)}%** in either direction from initial entry, both options legs will immediately close to protect capital.
                    </p>
                  </div>
                </div>

                <button 
                  type="submit"
                  className="w-full py-3.5 mt-2 rounded-xl bg-gradient-to-r from-cyan-400 to-indigo-500 hover:brightness-110 text-black font-extrabold uppercase tracking-wider text-xs transition duration-300 shadow-[0_0_15px_rgba(34,211,238,0.2)]"
                >
                  Save Decay1 Configuration
                </button>
              </form>
            )}

          </div>
        </div>

      </main>


      {/* COLLAPSIBLE LOGS DRAWER CONSOLE */}
      <div 
        className={`fixed bottom-0 left-0 right-0 z-45 bg-[#070b13]/95 border-t border-white/10 transition-all duration-300 ${
          consoleExpanded ? 'h-64' : 'h-11'
        } backdrop-blur-xl shadow-2xl flex flex-col`}
      >
        {/* Console Header Bar */}
        <div 
          onClick={() => setConsoleExpanded(!consoleExpanded)}
          className="flex justify-between items-center px-6 h-11 border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.02] select-none"
        >
          <div className="flex items-center gap-2.5">
            <Terminal className="w-4 h-4 text-cyan-400 animate-pulse" />
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-gray-300 font-mono">
              Live Database Console
            </span>
            <span className="text-[9px] bg-cyan-950/40 text-cyan-400 border border-cyan-500/20 px-2 py-0.5 rounded font-mono font-bold">
              {logs.length} events
            </span>
          </div>
          
          <div className="flex items-center gap-3">
            {/* Display latest log briefly in collapsed state */}
            {!consoleExpanded && logs.length > 0 && (
              <span className="hidden md:inline text-[10px] text-gray-500 font-mono truncate max-w-lg">
                Latest: {logs[0].message}
              </span>
            )}
            {consoleExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronUp className="w-4 h-4 text-gray-400" />}
          </div>
        </div>

        {/* Console Logs Body */}
        {consoleExpanded && (
          <div className="flex-1 p-5 overflow-y-auto font-mono text-[11px] leading-relaxed bg-[#05070d]/60 select-text">
            {logs.length === 0 ? (
              <div className="text-gray-600 italic py-4">No trading activity logs found in database. Waiting for events...</div>
            ) : (
              <div className="flex flex-col gap-1">
                {[...logs].reverse().map((log, index) => {
                  const dateStr = new Date(log.created_at).toLocaleTimeString('en-US', { hour12: false })
                  
                  let levelColor = 'text-cyan-400'
                  if (log.log_level === 'TRADE') levelColor = 'text-emerald-400 font-extrabold shadow-emerald-500/5 drop-shadow-[0_0_2px_rgba(16,185,129,0.3)]'
                  if (log.log_level === 'ERROR') levelColor = 'text-rose-400 font-extrabold drop-shadow-[0_0_2px_rgba(239,68,68,0.3)]'
                  
                  return (
                    <div key={log.id || index} className="flex items-start gap-2 text-gray-400 border-b border-white/[0.01] pb-0.5 hover:bg-white/[0.01] transition-colors">
                      <span className="text-gray-600 shrink-0 font-bold">[{dateStr}]</span>
                      <span className={`${levelColor} shrink-0 w-16 uppercase font-bold`}>[{log.log_level}]</span>
                      <span className="text-gray-500 shrink-0 font-semibold">{log.account_name || 'SYSTEM'}:</span>
                      <span className="text-gray-300 font-medium">{log.message}</span>
                    </div>
                  )
                })}
                <div ref={terminalEndRef} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ADD ACCOUNT KEY MODAL */}
      {showAddAccountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#0b0f19] border border-white/10 rounded-2xl p-6 w-full max-w-md flex flex-col gap-4 shadow-2xl backdrop-blur-xl animate-fade-in relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-cyan-400 to-indigo-500"></div>
            
            <h3 className="text-lg font-bold text-white font-['Space_Grotesk'] tracking-wide">Link Delta India Client API</h3>
            <p className="text-[11px] text-gray-500 -mt-1.5">Credentials are authenticated via standard HMAC-SHA256 protocol on-device.</p>
            
            <form onSubmit={handleAddAccount} className="flex flex-col gap-4.5 mt-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-mono">Account Tag Label</label>
                <input 
                  type="text" 
                  value={accName} 
                  onChange={e => setAccName(e.target.value)}
                  placeholder="e.g. Primary Strangle Account" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-bold"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-mono">Delta API Key</label>
                <input 
                  type="text" 
                  value={accKey} 
                  onChange={e => setAccKey(e.target.value)}
                  placeholder="Paste public API key" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-mono">Delta API Secret</label>
                <input 
                  type="password" 
                  value={accSecret} 
                  onChange={e => setAccSecret(e.target.value)}
                  placeholder="Paste private API secret key" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-mono">Environment Type</label>
                <select 
                  value={accEnv} 
                  onChange={e => setAccEnv(e.target.value)}
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-bold"
                >
                  <option value="testnet">Testnet Sandbox (Demo Accounts)</option>
                  <option value="production">Production Live Desk (Real Money)</option>
                </select>
              </div>

              <div className="flex gap-3 justify-end mt-4">
                <button 
                  type="button" 
                  onClick={() => setShowAddAccountModal(false)}
                  className="px-4 py-2 text-xs font-bold text-gray-400 hover:text-white uppercase tracking-wider transition font-mono"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="px-6 py-2 bg-gradient-to-r from-cyan-400 to-indigo-500 text-black text-xs font-bold uppercase tracking-wider rounded-xl transition duration-300 shadow-[0_0_15px_rgba(34,211,238,0.15)]"
                >
                  Confirm Link
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DOUBLE CONFIRM SQUARE OFF / SLIPPAGE WARNING MODAL */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#0c101d] border border-white/10 rounded-2xl p-6 w-full max-w-md flex flex-col gap-4 text-center shadow-2xl relative overflow-hidden animate-fade-in">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-rose-500 shadow-[0_0_10px_#ef4444]"></div>
            
            <div className="mx-auto w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 shadow-[0_0_15px_rgba(239,68,68,0.1)] animate-pulse">
              <AlertTriangle className="w-6 h-6 animate-bounce" />
            </div>
            
            <div>
              <h3 className="text-lg font-bold text-white tracking-wide font-['Space_Grotesk']">{showConfirmModal.title}</h3>
              <p className="text-xs text-gray-400 mt-3 leading-relaxed">
                {showConfirmModal.message}
              </p>
              <div className="mt-4 bg-rose-950/20 p-3 rounded-xl border border-rose-500/15 text-[10px] text-rose-400 font-bold uppercase tracking-wider">
                WARNING: Slippage may occur during high-volatility events.
              </div>
            </div>
            
            <div className="flex gap-3 justify-center mt-3.5">
              <button 
                onClick={() => setShowConfirmModal(null)}
                className="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-400 hover:text-white uppercase tracking-wider transition font-mono"
              >
                Cancel
              </button>
              <button 
                onClick={handleEmergencyClose}
                className="px-6 py-2.5 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold uppercase tracking-wider rounded-xl transition duration-300 shadow-lg shadow-rose-950/40"
              >
                Confirm market square off
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PREMIUM FLOATING TOASTS CONTAINER */}
      <div className="fixed bottom-14 right-5 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map(t => (
          <div 
            key={t.id} 
            className={`px-4 py-3.5 rounded-xl border text-xs font-semibold shadow-2xl backdrop-blur-xl transition-all duration-300 flex items-center gap-3 border-l-4 animate-slide-in-right ${
              t.type === 'error' 
              ? 'bg-rose-950/40 text-rose-300 border-rose-500/40 border-l-rose-500 shadow-[0_0_20px_rgba(239,68,68,0.12)]' 
              : t.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-500/40 border-l-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.12)]'
              : 'bg-cyan-950/40 text-cyan-300 border-cyan-500/40 border-l-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.12)]'
            }`}
          >
            {t.type === 'error' && <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />}
            {t.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />}
            {t.type === 'info' && <Activity className="w-4 h-4 shrink-0 text-cyan-400" />}
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>

    </div>
  )
}
