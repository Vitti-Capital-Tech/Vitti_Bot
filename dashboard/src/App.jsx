import React, { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'
import { 
  Shield, 
  Activity, 
  Wallet,
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
  Info,
  Sun,
  Moon,
  Pause,
  Play,
  History
} from 'lucide-react'

export default function App() {
  // Database States
  const [accounts, setAccounts] = useState([])
  const [strategy, setStrategy] = useState(null)
  const [strategiesList, setStrategiesList] = useState([])
  const [selectedConfigStrategy, setSelectedConfigStrategy] = useState('decay1')
  const [positions, setPositions] = useState([])
  const [logs, setLogs] = useState([])
  const [historyPositions, setHistoryPositions] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  
  const [toasts, setToasts] = useState([])
  const [lastLogId, setLastLogId] = useState(null)
  const [showConfirmModal, setShowConfirmModal] = useState(null) // holds { ids, title, message } or null
  
  // Real-time strategy config preview state
  const [formValues, setFormValues] = useState({})
  
  const handleFieldChange = (stratName, field, value) => {
    setFormValues(prev => ({
      ...prev,
      [`${stratName}_${field}`]: value
    }))
  }
  
  // UI states
  const [loading, setLoading] = useState(true)
  const [showAddAccountModal, setShowAddAccountModal] = useState(false)
  const [activeTab, setActiveTab] = useState('positions') // 'positions' | 'accounts' | 'config'
  const [consoleExpanded, setConsoleExpanded] = useState(false)
  
  // Theme state: 'dark' | 'light'
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark'
  })

  // Synchronize theme with DOM root class
  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light')
      document.documentElement.classList.remove('dark')
    } else {
      document.documentElement.classList.add('dark')
      document.documentElement.classList.remove('light')
    }
    localStorage.setItem('theme', theme)
  }, [theme])

  // Reset strategy config edit forms when changing tabs
  useEffect(() => {
    setFormValues({})
  }, [activeTab])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const [currency, setCurrency] = useState(() => {
    return localStorage.getItem('vitti_currency') || 'USD'
  })

  // Format currency value based on USD / INR toggle
  const formatAmount = (val, decimals = 4) => {
    const numericVal = parseFloat(val) || 0.0
    if (currency === 'INR') {
      const inrVal = numericVal * 85
      return `₹${inrVal.toFixed(decimals === 4 ? 2 : decimals)}`
    }
    return `$${numericVal.toFixed(decimals)}`
  }
  
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
        
        // 2. Fetch Strategies
        const strats = await supabase.from('strategies').select('*').order('name')
        if (strats.data) {
          setStrategiesList(strats.data)
          const activeStrat = strats.data.find(s => s.name === selectedConfigStrategy) || strats.data[0]
          if (activeStrat) setStrategy(activeStrat)
        }
        
        // 3. Fetch Positions (Open or Closed Today)
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)
        const pos = await supabase
          .from('positions')
          .select('*')
          .or(`status.eq.open,and(status.eq.closed,created_at.gte.${todayStart.toISOString()})`)
          .order('created_at', { ascending: false })
        if (pos.data) setPositions(pos.data)
        
        // 4. Fetch Logs
        const lg = await supabase.from('trade_logs').select('*').order('created_at', { ascending: false }).limit(200)
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

  // Fetch closed positions history when activeTab is history
  useEffect(() => {
    async function fetchHistory() {
      if (activeTab !== 'history') return
      // Only trigger visual spinner on initial page load
      if (historyPositions.length === 0) {
        setHistoryLoading(true)
      }
      try {
        const { data, error } = await supabase
          .from('positions')
          .select('*, accounts(name, env)')
          .eq('status', 'closed')
          .order('closed_at', { ascending: false })
        if (data) setHistoryPositions(data)
      } catch (err) {
        console.error("Error fetching trade history:", err)
      } finally {
        setHistoryLoading(false)
      }
    }
    fetchHistory()
  }, [activeTab, refreshTrigger])

  // Synchronize selected strategy config when selectedConfigStrategy or strategiesList changes
  useEffect(() => {
    if (strategiesList.length > 0) {
      const activeStrat = strategiesList.find(s => s.name === selectedConfigStrategy) || strategiesList[0]
      if (activeStrat) setStrategy(activeStrat)
    }
  }, [selectedConfigStrategy, strategiesList])

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

  const handleToggleStrategyForObject = async (strat) => {
    try {
      await supabase.from('strategies').update({ is_active: !strat.is_active }).eq('id', strat.id)
      setRefreshTrigger(prev => prev + 1)
      showToast(`Strategy ${strat.name.toUpperCase()} is now ${!strat.is_active ? 'ENABLED' : 'PAUSED'}.`, !strat.is_active ? 'success' : 'info')
    } catch (err) {
      console.error(err)
      showToast(`Failed to toggle ${strat.name.toUpperCase()} strategy.`, 'error')
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

  const handleUpdateConfigForStrategy = (strat) => async (e) => {
    e.preventDefault()
    const formData = new FormData(e.target)
    const sl = parseFloat(formData.get('sl_multiplier'))
    const entry = formData.get('entry_time')
    const exit = formData.get('exit_time')
    const tgt = parseFloat(formData.get('target_pct'))
    const strike = formData.get('strike_selection')
    
    try {
      await supabase.from('strategies').update({
        sl_multiplier: sl,
        entry_time_ist: entry,
        exit_time_ist: exit,
        underlying_target_pct: tgt,
        strike_selection: strike
      }).eq('id', strat.id)
      showToast(`${strat.name.toUpperCase()} strategy parameters updated.`, 'success')
      // Clear unsaved edit states for this strategy so it falls back to DB values
      setFormValues(prev => {
        const next = { ...prev }
        delete next[`${strat.name}_sl`]
        delete next[`${strat.name}_target`]
        delete next[`${strat.name}_entry`]
        delete next[`${strat.name}_exit`]
        delete next[`${strat.name}_strike`]
        return next
      })
      setRefreshTrigger(prev => prev + 1)
    } catch (err) {
      console.error(err)
      showToast(`Failed to update ${strat.name.toUpperCase()} strategy config.`, 'error')
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
    const isSingle = ids.length === 1
    setShowConfirmModal({
      ids,
      title: isSingle ? "Confirm Single Leg Exit" : "Confirm Double Strangle Exit",
      message: isSingle
        ? `You are requesting an emergency square-off for the remaining leg in account [${accountName}]. This will dispatch a market close order.`
        : `You are requesting a combined square-off for ALL open legs in account [${accountName}]. This will dispatch concurrent market close orders to minimize slippage.`
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
  const activePositions = positions.filter(p => p.status === 'open')
  const totalPnL = activePositions.reduce((acc, pos) => acc + (parseFloat(pos.pnl) || 0.0), 0.0)

  // Group positions by Account ID + Strategy Name to render consolidated Strangles
  const getGroupedStrangles = () => {
    const groups = {}
    activePositions.forEach(pos => {
      const key = `${pos.account_id}_${pos.strategy_name}`
      if (!groups[key]) {
        groups[key] = []
      }
      groups[key].push(pos)
    })

    return Object.keys(groups).map(groupKey => {
      const [accId, strategyName] = groupKey.split('_')
      const accDetails = accounts.find(a => a.id === accId) || { name: 'Linked Account', env: 'production' }
      const accPosList = groups[groupKey]
      
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

      const nameParts = (accDetails.name || '').split('|')
      const baseName = nameParts[0]
      const actualBalance = nameParts[1] ? parseFloat(nameParts[1]) : 10000.0

      return {
        accountId: accId,
        accountName: baseName,
        accountBalance: actualBalance,
        env: accDetails.env,
        strategyName,
        stranglePairs,
        unpaired
      }
    })
  }

  const groupedStrangles = getGroupedStrangles()

  // Calculate Active Strangle accounts
  const activeStrangleAccountsCount = groupedStrangles.filter(g => g.stranglePairs.length > 0 || g.unpaired.length > 0).length

  // Calculate Account metrics
  const activeAccountsCount = accounts.filter(a => a.is_active).length
  const totalAccountsCount = accounts.length
  const totalActiveBalance = accounts
    .filter(a => a.is_active)
    .reduce((sum, acc) => {
      const nameParts = (acc.name || '').split('|')
      const bal = nameParts[1] ? parseFloat(nameParts[1]) : 10000.0
      return sum + bal
    }, 0.0)

  // Determine daemon health status: check if we received logs within last 5 minutes
  const isDaemonHealthy = () => {
    if (logs.length === 0) return false
    const latestLogTime = new Date(logs[0].created_at)
    const differenceInMinutes = (new Date() - latestLogTime) / (1000 * 60)
    return differenceInMinutes < 10 // Healthy if a log event happened in last 10 mins (including bot heartbeats)
  }

  const formatDateTime = (isoString) => {
    if (!isoString) return 'NA'
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    })
  }

  const getGroupedHistory = () => {
    const dateGroups = {}
    historyPositions.forEach(pos => {
      if (!pos.closed_at) return
      const dateStr = new Date(pos.closed_at).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).toUpperCase()
      
      if (!dateGroups[dateStr]) {
        dateGroups[dateStr] = []
      }
      dateGroups[dateStr].push(pos)
    })
    
    return Object.keys(dateGroups).map(dateStr => {
      const datePosList = dateGroups[dateStr]
      const accountGroups = {}
      
      datePosList.forEach(pos => {
        const accId = pos.account_id
        if (!accountGroups[accId]) {
          accountGroups[accId] = []
        }
        accountGroups[accId].push(pos)
      })
      
      const accounts = Object.keys(accountGroups).map(accId => {
        const accPosList = accountGroups[accId]
        const dbName = accPosList[0].accounts?.name || 'Linked Account'
        const [accName, accBalance] = dbName.split('|')
        const accEnv = accPosList[0].accounts?.env || 'production'
        
        // Group by strategy inside the account
        const strategyGroups = {}
        accPosList.forEach(pos => {
          const strat = pos.strategy_name || 'decay1'
          if (!strategyGroups[strat]) {
            strategyGroups[strat] = []
          }
          strategyGroups[strat].push(pos)
        })
        
        const strategies = Object.keys(strategyGroups).map(strategyName => {
          const stratPosList = strategyGroups[strategyName]
          const calls = stratPosList.filter(p => p.symbol.startsWith('C-'))
          const puts = stratPosList.filter(p => p.symbol.startsWith('P-'))
          
          const stranglePairs = []
          const unpaired = []
          const usedPuts = new Set()
          
          calls.forEach(c => {
            const cParsed = parseOptionSymbol(c.symbol)
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
          
          puts.forEach(p => {
            if (!usedPuts.has(p.id)) {
              unpaired.push(p)
            }
          })
          
          const strategyPnL = stratPosList.reduce((acc, p) => acc + (parseFloat(p.pnl) || 0.0), 0.0)
          
          return {
            strategyName,
            stranglePairs,
            unpaired,
            strategyPnL
          }
        })
        
        const totalAccountPnL = accPosList.reduce((acc, p) => acc + (parseFloat(p.pnl) || 0.0), 0.0)
        
        return {
          accountId: accId,
          accountName: accName,
          accountBalance: accBalance ? parseFloat(accBalance) : null,
          env: accEnv,
          strategies,
          totalAccountPnL
        }
      })
      
      return {
        dateStr,
        accounts
      }
    })
  }

  return (
    <div className="min-h-screen bg-[#05070e] text-gray-200 flex flex-col font-sans relative overflow-hidden pb-16">
      
      {/* Ambient light orbs */}
      <div className="absolute -top-32 left-1/4 w-[700px] h-[500px] bg-cyan-500/[0.055] rounded-full blur-[160px] pointer-events-none" />
      <div className="absolute top-1/3 -right-32 w-[600px] h-[600px] bg-indigo-500/[0.05] rounded-full blur-[180px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[400px] bg-emerald-500/[0.03] rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-indigo-600/[0.02] rounded-full blur-[200px] pointer-events-none" />
      
      {/* MAIN HEADER NAVBAR */}
      <header className="border-b border-white/5 bg-[#070a13]/60 sticky top-0 z-40 backdrop-blur-2xl">
        {/* Top hairline gradient accent */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex flex-col md:flex-row items-center justify-between gap-4">
          
          {/* LEFT — Logo + Live Badge */}
          <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-3.5">
              {/* Logo mark */}
              <img src="/logo.jpeg" alt="VITTI Bot Logo" className="w-9 h-9 rounded-xl object-cover shadow-lg" />
              <div className="flex flex-col justify-center">
                <div className="flex items-center gap-2">
                  <h1 className="text-[17px] font-extrabold tracking-tight text-white leading-none">
                    VITTI Bot
                  </h1>
                </div>
              </div>
            </div>
          </div>
          
          {/* CENTER — Navigation Tabs */}
          <div className="flex items-center gap-0.5 bg-[#090d16]/80 border border-white/5 p-1 rounded-xl w-full md:w-auto overflow-x-auto scrollbar-none shadow-inner">
            {[
              { id: 'positions', label: 'Live Positions', icon: Activity },
              { id: 'history', label: 'Trade History', icon: History },
              { id: 'accounts', label: 'Trading Accounts', icon: UserPlus },
              { id: 'config', label: 'Configure Strategies', icon: Sliders }
            ].map(tab => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center justify-center gap-1.5 px-4 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all duration-200 whitespace-nowrap focus:outline-none focus:ring-0 ${
                    isActive
                    ? 'tab-active'
                    : 'text-gray-500 hover:text-gray-300 border border-transparent hover:bg-white/[0.03]'
                  }`}
                >
                  <tab.icon className={`w-3.5 h-3.5 ${isActive ? 'text-cyan-400' : ''}`} />
                  {tab.label}
                </button>
              )
            })}
          </div>
          
          {/* RIGHT — Controls */}
          <div className="flex items-center gap-2 w-full md:w-auto justify-end">
            <button
              onClick={() => {
                const nextCurrency = currency === 'USD' ? 'INR' : 'USD'
                setCurrency(nextCurrency)
                localStorage.setItem('vitti_currency', nextCurrency)
              }}
              className="px-3.5 py-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 transition-all duration-200 text-[10px] font-black tracking-widest text-cyan-400 font-sans uppercase flex items-center gap-1.5 focus:outline-none"
              title={`Switch display to ${currency === 'USD' ? 'INR' : 'USD'}`}
            >
              <span>{currency === 'USD' ? '$ USD' : '₹ INR'}</span>
            </button>
            <button
              onClick={toggleTheme}
              className="p-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 transition-all duration-200"
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Moon className="w-4 h-4 text-indigo-400" />
              )}
            </button>
            <button
              onClick={() => {
                setRefreshTrigger(prev => prev + 1)
                showToast("Manual data sync complete.", 'info')
              }}
              className="p-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 transition-all duration-200"
              title="Sync Data"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-cyan-400' : 'text-gray-500'}`} />
            </button>
          </div>
        </div>
      </header>

      {/* MAIN LAYOUT */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 flex flex-col gap-8 z-10">

        {/* KPI INSTITUTIONAL METRICS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">

          {/* Card 1 — Unrealized PnL */}
          <div className="glass-panel kpi-card-cyan rounded-2xl p-6 relative border border-white/5 bg-[#0b0f1d] transition-all duration-300">
            {/* Faint background icon container */}
            <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none select-none">
              <div className="absolute -right-2 -bottom-2 opacity-[0.025]">
                <DollarSign className="w-32 h-32 text-cyan-400" />
              </div>
            </div>
            {/* Top row */}
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-lg bg-cyan-500/10 border border-cyan-500/15 flex items-center justify-center">
                  <DollarSign className="w-3 h-3 text-cyan-400" />
                </div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-sans">Unrealized PnL</p>
                <div className="tooltip-trigger tooltip-below">
                  <Info className="w-3 h-3 text-gray-600 hover:text-cyan-400 cursor-help transition-colors" />
                  <span className="tooltip-content">Real-time consolidated options strangle yield</span>
                </div>
              </div>
              <span className={`text-[9px] px-2 py-0.5 rounded-md font-extrabold tracking-wider border ${
                totalPnL >= 0
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
              }`}>
                {totalPnL >= 0 ? 'PROFIT' : 'DRAWDOWN'}
              </span>
            </div>
            {/* Big number */}
            <h3 className={`text-[2rem] font-black mt-4 tracking-tight font-sans leading-none ${
              totalPnL >= 0
              ? 'text-emerald-400 drop-shadow-[0_0_18px_rgba(16,185,129,0.25)]'
              : 'text-rose-400 drop-shadow-[0_0_18px_rgba(244,63,94,0.25)]'
            }`}>
              {totalPnL >= 0 ? '+' : ''}{formatAmount(totalPnL, 4)}
            </h3>
          </div>

          {/* Card 2 — Active Strangle Pairs */}
          <div className="glass-panel kpi-card-indigo rounded-2xl p-6 relative border border-white/5 bg-[#0b0f1d] transition-all duration-300">
            {/* Faint background icon container */}
            <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none select-none">
              <div className="absolute -right-2 -bottom-2 opacity-[0.025]">
                <Layers className="w-32 h-32 text-indigo-400" />
              </div>
            </div>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-lg bg-indigo-500/10 border border-indigo-500/15 flex items-center justify-center">
                  <Layers className="w-3 h-3 text-indigo-400" />
                </div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-sans">Active Strangle Pairs</p>
                <div className="tooltip-trigger tooltip-below">
                  <Info className="w-3 h-3 text-gray-600 hover:text-indigo-400 cursor-help transition-colors" />
                  <span className="tooltip-content">Simultaneous strangle monitoring at Delta Exchange</span>
                </div>
              </div>
              <span className="text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-md font-bold tracking-wider font-sans">
                {activeStrangleAccountsCount} ACCOUNTS
              </span>
            </div>
            <h3 className="text-[2rem] font-black mt-4 tracking-tight font-sans leading-none text-white">
              {activePositions.length}
              <span className="text-sm font-semibold text-gray-500 ml-1.5">Option Legs</span>
            </h3>
          </div>

          {/* Card 3 — Total Strategies */}
          <div className="glass-panel kpi-card-amber rounded-2xl p-6 relative border border-white/5 bg-[#0b0f1d] transition-all duration-300">
            {/* Faint background icon container */}
            <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none select-none">
              <div className="absolute -right-2 -bottom-2 opacity-[0.025]">
                <Sliders className="w-32 h-32 text-amber-400" />
              </div>
            </div>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-lg bg-amber-500/10 border border-amber-500/15 flex items-center justify-center">
                  <Sliders className="w-3 h-3 text-amber-400" />
                </div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-sans">Total Strategies</p>
              </div>
              <span className="text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-md font-bold tracking-wider font-sans">
                {strategiesList.filter(s => s.is_active).length} / {strategiesList.length} ACTIVE
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-2.5">
              {strategiesList.map(strat => (
                <div key={strat.id} className="flex items-center justify-between border-b border-white/[0.03] last:border-0 pb-2 last:pb-0">
                  <div>
                    <p className="text-xs font-bold text-white font-sans uppercase tracking-wide flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${strat.is_active ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                      {strat.name}
                      <span className="tooltip-trigger tooltip-below">
                        <Info className="w-3 h-3 text-gray-600 hover:text-indigo-400 cursor-help transition-colors" />
                        <span className="tooltip-content">
                          <div className="flex flex-col gap-1 text-[10px] text-gray-300 font-sans normal-case tracking-normal">
                            <div>{strat.entry_time_ist} to {strat.exit_time_ist} IST • {strat.underlying}</div>
                            <div className="font-semibold text-cyan-400 uppercase mt-0.5">{strat.strike_selection.toUpperCase()}</div>
                          </div>
                        </span>
                      </span>
                    </p>
                  </div>
                  <span className={`text-[8px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                    strat.is_active
                    ? 'text-emerald-400 bg-emerald-500/8 border-emerald-500/15'
                    : 'text-rose-400 bg-rose-500/8 border-rose-500/15'
                  }`}>{strat.is_active ? 'On' : 'Off'}</span>
                </div>
              ))}
              {strategiesList.length === 0 && (
                <p className="text-xs text-gray-600 mt-1">Loading strategy metrics...</p>
              )}
            </div>
          </div>

          {/* Card 4 — Trading Accounts Balance */}
          <div className="glass-panel kpi-card-cyan rounded-2xl p-6 relative border border-white/5 bg-[#0b0f1d] transition-all duration-300">
            {/* Faint background icon container */}
            <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none select-none">
              <div className="absolute -right-2 -bottom-2 opacity-[0.025]">
                <Wallet className="w-32 h-32 text-emerald-400" />
              </div>
            </div>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-lg bg-emerald-500/10 border border-emerald-500/15 flex items-center justify-center">
                  <Wallet className="w-3 h-3 text-emerald-400" />
                </div>
                <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest font-sans">Trading Accounts</p>
              </div>
              <span className="text-[9px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-md font-bold tracking-wider font-sans">
                {activeAccountsCount} / {totalAccountsCount} ACTIVE
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-2.5">
              {accounts.map(acc => {
                const nameParts = (acc.name || '').split('|')
                const baseName = nameParts[0]
                const bal = nameParts[1] ? parseFloat(nameParts[1]) : 10000.0
                return (
                  <div key={acc.id} className="flex items-center justify-between border-b border-white/[0.02] last:border-0 pb-2 last:pb-0">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-white font-sans uppercase tracking-wide flex items-center gap-1.5 truncate">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${acc.is_active ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                        <span className="truncate">{baseName}</span>
                        <span className="text-[9px] font-mono text-gray-500 shrink-0">({formatAmount(bal, 2)})</span>
                      </p>
                    </div>
                    <span className={`text-[8px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${
                      acc.is_active
                      ? 'text-emerald-400 bg-emerald-500/8 border-emerald-500/15'
                      : 'text-rose-400 bg-rose-500/8 border-rose-500/15'
                    }`}>{acc.is_active ? 'On' : 'Off'}</span>
                  </div>
                )
              })}
              {accounts.length === 0 && (
                <p className="text-xs text-gray-600 mt-1">Loading accounts...</p>
              )}
            </div>
          </div>
        </div>

        {/* MAIN CONSOLE PANEL */}
        <div className="relative min-h-[500px] w-full flex-1 border-t border-white/[0.03] pt-8">
            
            {/* POSITIONS & STRANGLE WORKSPACE */}
            <div className={`transition-all duration-350 ease-in-out transform flex flex-col gap-8 ${
              activeTab === 'positions' 
              ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
              : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-0 top-0 z-0'
            }`}>
                {activePositions.length === 0 ? (
                  /* INSTITUTIONAL STANDBY WORKSPACE */
                  <div className="flex flex-col gap-8 items-center py-8">
                    
                    {/* Standby Banner */}
                    <div className="w-full max-w-2xl flex flex-col items-center justify-center text-center p-12 rounded-2xl bg-white/[0.01] border border-white/5">
                      <div className="w-16 h-16 rounded-full bg-cyan-500/5 border border-cyan-500/10 flex items-center justify-center text-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.05)] mb-4 animate-pulse">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <h4 className="text-xl font-bold text-white tracking-wide">Strangle Execution Idle</h4>
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

                  </div>
                ) : (
                  /* PREMIUM STRANGLE PAIR WORKSPACE */
                  <div className="flex flex-col gap-8">
                    
                    {groupedStrangles.map(group => {
                      const hasActiveStrangle = group.stranglePairs.length > 0 || group.unpaired.length > 0
                      if (!hasActiveStrangle) return null
                      
                      const allGroupPositions = [...group.stranglePairs.flatMap(p => [p.call, p.put]), ...group.unpaired]
                      const isSingleLeg = allGroupPositions.length === 1

                      return (
                        <div key={`${group.accountId}_${group.strategyName}`} className="glass-card rounded-2xl border border-white/5 bg-[#0d1222]/30 p-6 flex flex-col gap-6 shadow-xl relative overflow-hidden">
                          
                          {/* Top Header Row of Account workspace */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-white/5 pb-4 gap-3">
                            <div className="flex items-center gap-3">
                              {/* Pulsing Status Indicator */}
                              <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 live-dot shadow-[0_0_8px_rgba(34,211,238,0.4)] shrink-0" />
                              <div>
                                <h4 className="font-bold text-white text-lg tracking-tight">{group.accountName}</h4>
                                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                  <span className={`text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 border rounded-md ${
                                    group.env === 'production' 
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.03)]' 
                                    : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.05)]'
                                  }`}>
                                    {group.env === 'production' ? 'LIVE' : 'DEMO'}
                                  </span>
                                  <span className="text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 border rounded-md bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.03)]">
                                    STRATEGY: {(group.strategyName || 'decay1').toUpperCase()}
                                  </span>
                                  <span className="text-[8px] font-extrabold uppercase tracking-widest px-2 py-0.5 border rounded-md bg-indigo-500/10 text-indigo-400 border-indigo-500/20 shadow-[0_0_10px_rgba(99,102,241,0.03)]">
                                    ACTIVE STRANGLE
                                  </span>
                                </div>
                              </div>
                            </div>
                            
                            {/* Strangle Double Exit Panel */}
                            <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
                              {allGroupPositions.some(p => p.status === 'open') ? (
                                <button
                                  onClick={() => triggerStrangleClose(allGroupPositions, group.accountName)}
                                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-600 text-rose-400 hover:text-white border border-rose-500/20 hover:border-rose-600 hover:shadow-[0_0_20px_rgba(244,63,94,0.3)] text-[10px] font-extrabold uppercase tracking-wider transition-all duration-300 transform active:scale-95 cursor-pointer shrink-0"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5" />
                                  <span>{isSingleLeg ? "Square Off Remaining Leg" : "Square Off Strangle (Both Legs)"}</span>
                                </button>
                              ) : (
                                <div className="flex items-center gap-1.5 bg-gray-500/10 text-gray-500 border border-gray-500/20 px-4 py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-wider shrink-0 select-none">
                                  <span>Strangle Squared Off</span>
                                </div>
                              )}
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
                                
                                {/* Unified Premium Stats Ribbon */}
                                <div className="bg-[#080b13]/80 rounded-xl border border-white/5 divide-y divide-white/5 md:divide-y-0 md:divide-x md:grid md:grid-cols-4 text-xs font-mono">
                                  <div className="p-4 flex flex-col justify-center">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Entry Value</p>
                                    <p className="text-sm md:text-base font-black text-white mt-1 font-mono">{formatAmount(entrySum, 4)}</p>
                                  </div>
                                  <div className="p-4 flex flex-col justify-center md:pl-6">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Current Mark</p>
                                    <p className="text-sm md:text-base font-black text-gray-400 mt-1 font-mono">{formatAmount(markSum, 4)}</p>
                                  </div>
                                  <div className="p-4 flex flex-col justify-center md:pl-6">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Strangle Pair PnL</p>
                                    <div className="flex flex-wrap items-baseline gap-2 mt-1 font-mono">
                                      <span className={`text-sm md:text-base font-black ${pairPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {pairPnL >= 0 ? '+' : ''}{formatAmount(pairPnL, 4)}
                                      </span>
                                      <span className={`text-[10px] font-extrabold ${decayPct >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
                                        ({decayPct >= 0 ? '+' : ''}{decayPct.toFixed(1)}%)
                                      </span>
                                    </div>
                                  </div>
                                  <div className="p-4 flex flex-col justify-center md:pl-6">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-widest font-sans font-bold">Account Balance</p>
                                    <p className="text-sm md:text-base font-black text-white mt-1 font-mono">
                                      {formatAmount(group.accountBalance + pairPnL, 2)}
                                    </p>
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
                                      <div key={lIdx} className={`p-4 rounded-xl border relative overflow-hidden bg-white/[0.01] transition-all duration-300 ${
                                        isCall 
                                        ? 'border-amber-500/10 hover:border-amber-500/20 bg-amber-500/[0.005]' 
                                        : 'border-indigo-500/10 hover:border-indigo-500/20 bg-indigo-500/[0.005]'
                                      }`}>
                                        
                                        {/* Background indicator */}
                                        <div className={`absolute right-4 bottom-2 opacity-[0.03] pointer-events-none font-black font-mono text-8xl select-none leading-none ${
                                          isCall ? 'text-amber-500' : 'text-indigo-500'
                                        }`}>
                                          {isCall ? 'C' : 'P'}
                                        </div>

                                        <div className="flex justify-between items-center border-b border-white/5 pb-2.5 gap-2 relative z-10">
                                          <div className="flex items-center gap-2">
                                            <span className="font-extrabold text-white text-sm font-mono tracking-tight">{leg.symbol}</span>
                                            <span className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest border ${
                                              isCall 
                                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                              : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                                            }`}>
                                              {isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                            </span>
                                          </div>
                                          
                                          <div className="flex items-center gap-3">
                                            <span className={`font-mono text-xs font-bold shrink-0 ${legPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                              {legPnL >= 0 ? '+' : ''}{formatAmount(legPnL, 4)}
                                            </span>
                                            {leg.status === 'closed' ? (
                                              <span className="px-2.5 py-1.5 rounded-lg bg-gray-500/10 text-gray-500 border border-gray-500/20 text-[8px] font-extrabold uppercase tracking-wider shrink-0 select-none">
                                                Closed
                                              </span>
                                            ) : (
                                              <button
                                                onClick={() => triggerLegClose(leg.id, leg.symbol)}
                                                className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/20 transition-all text-[8px] font-bold uppercase tracking-wider shrink-0 cursor-pointer active:scale-95"
                                              >
                                                Exit Leg
                                              </button>
                                            )}
                                          </div>
                                        </div>

                                        <div className="grid grid-cols-3 gap-y-3.5 gap-x-2 mt-4 text-[10px] font-mono relative z-10">
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Option Strike</span>
                                            <span className="text-white text-xs mt-1 font-bold font-mono">${legParsed.strike.toLocaleString()}</span>
                                          </div>
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Contract Size</span>
                                            <span className="text-gray-300 text-xs mt-1 font-bold font-mono">{leg.size} Cont</span>
                                          </div>
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Stop Loss</span>
                                            <span className="text-rose-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.sl_price || 0).toFixed(2)}</span>
                                          </div>
                                          
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Entry Price</span>
                                            <span className="text-gray-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.entry_price).toFixed(2)}</span>
                                          </div>
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Mark Price</span>
                                            <span className="text-cyan-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.mark_price || 0).toFixed(2)}</span>
                                          </div>
                                          <div className="flex flex-col">
                                            <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">{leg.strategy_name === 'decay2' ? 'Take Profit' : 'Spot Target'}</span>
                                            <span className="text-emerald-400 text-xs mt-1 font-bold font-mono">
                                              {leg.strategy_name === 'decay2' ? `$${parseFloat(leg.tp_price || 0).toFixed(2)}` : `$${parseFloat(leg.tp_price || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
                                            </span>
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
                                    <div key={idx} className={`p-4 rounded-xl border relative overflow-hidden bg-white/[0.01] transition-all duration-300 ${
                                      isCall 
                                      ? 'border-amber-500/10 hover:border-amber-500/20 bg-amber-500/[0.005]' 
                                      : 'border-indigo-500/10 hover:border-indigo-500/20 bg-indigo-500/[0.005]'
                                    }`}>
                                      
                                      {/* Background indicator */}
                                      <div className={`absolute right-4 bottom-2 opacity-[0.03] pointer-events-none font-black font-mono text-8xl select-none leading-none ${
                                        isCall ? 'text-amber-500' : 'text-indigo-500'
                                      }`}>
                                        {isCall ? 'C' : 'P'}
                                      </div>

                                      <div className="flex justify-between items-center border-b border-white/5 pb-2.5 gap-2 relative z-10">
                                        <div className="flex items-center gap-2">
                                          <span className="font-extrabold text-white text-sm font-mono tracking-tight">{leg.symbol}</span>
                                          <span className={`px-2 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest border ${
                                            isCall 
                                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                            : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                                          }`}>
                                            {isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                          </span>
                                          <span className="px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                            UNPAIRED
                                          </span>
                                        </div>
                                        
                                        <div className="flex items-center gap-3">
                                          <span className={`font-mono text-xs font-bold shrink-0 ${legPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {legPnL >= 0 ? '+' : ''}{formatAmount(legPnL, 4)}
                                          </span>
                                          {leg.status === 'closed' ? (
                                            <span className="px-2.5 py-1.5 rounded-lg bg-gray-500/10 text-gray-500 border border-gray-500/20 text-[8px] font-extrabold uppercase tracking-wider shrink-0 select-none">
                                              Closed
                                            </span>
                                          ) : (
                                            <button
                                              onClick={() => triggerLegClose(leg.id, leg.symbol)}
                                              className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/20 transition-all text-[8px] font-bold uppercase tracking-wider shrink-0 cursor-pointer active:scale-95"
                                            >
                                              Square Off
                                            </button>
                                          )}
                                        </div>
                                      </div>

                                      <div className="grid grid-cols-3 gap-y-3.5 gap-x-2 mt-4 text-[10px] font-mono relative z-10">
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Strike</span>
                                          <span className="text-white text-xs mt-1 font-bold font-mono">${legParsed.strike.toLocaleString()}</span>
                                        </div>
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Size</span>
                                          <span className="text-gray-300 text-xs mt-1 font-bold font-mono">{leg.size} Cont</span>
                                        </div>
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">SL Trigger</span>
                                          <span className="text-rose-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.sl_price || 0).toFixed(2)}</span>
                                        </div>
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Entry Price</span>
                                          <span className="text-gray-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.entry_price).toFixed(2)}</span>
                                        </div>
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Mark Price</span>
                                          <span className="text-cyan-400 text-xs mt-1 font-bold font-mono">${parseFloat(leg.mark_price || 0).toFixed(2)}</span>
                                        </div>
                                        <div className="flex flex-col">
                                          <span className="text-[9px] text-gray-500 uppercase font-sans tracking-wider font-semibold">Account Balance</span>
                                          <span className="text-white text-xs mt-1 font-bold font-mono">{formatAmount(group.accountBalance + legPnL, 2)}</span>
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

            {/* TRADE HISTORY */}
            <div className={`transition-all duration-350 ease-in-out transform flex flex-col gap-8 w-full max-w-7xl ${
              activeTab === 'history' 
              ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
              : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-0 top-0 z-0'
            }`}>
              
              <div className="flex flex-col sm:flex-row justify-between sm:items-center border-b border-white/[0.04] pb-4.5 gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white tracking-wide">Completed Trade Records</h3>
                  <div className="tooltip-trigger">
                    <Info className="w-3.5 h-3.5 text-gray-500 hover:text-indigo-400 cursor-help transition-colors" />
                    <span className="tooltip-content">
                      Historical log of closed short strangle positions grouped by date and strategy.
                    </span>
                  </div>
                </div>
              </div>

              {historyLoading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
                  <p className="text-xs text-gray-500">Retrieving closed trade records...</p>
                </div>
              ) : historyPositions.length === 0 ? (
                <div className="text-center py-20 border border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                  <History className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                  <h4 className="text-sm font-bold text-gray-400">No completed trades found</h4>
                  <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto leading-relaxed">
                    Once options strangles are closed via time exit, stop loss, or manual square-off, they will appear here.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-10">
                  {getGroupedHistory().map(dateGroup => (
                    <div key={dateGroup.dateStr} className="flex flex-col gap-4">
                      {/* Date Heading Ribbon */}
                      <div className="flex items-center gap-4">
                        <span className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-400 bg-cyan-950/30 border border-cyan-800/30 px-3 py-1 rounded-md font-mono select-none">
                          {dateGroup.dateStr}
                        </span>
                        <div className="h-px bg-white/5 flex-1" />
                      </div>

                      {/* Strangles executed on this date */}
                      <div className="flex flex-col gap-6">
                        {dateGroup.accounts.map(account => {
                          return (
                            <div key={account.accountId} className="glass-card rounded-2xl border border-white/5 bg-[#0d1222]/20 p-5 flex flex-col gap-5 shadow-lg relative overflow-hidden">
                              {/* Account Header */}
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-white/5 pb-3 gap-3">
                                <div className="flex items-center gap-2.5">
                                  <div className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" />
                                  <div>
                                    <h4 className="font-extrabold text-white text-sm tracking-tight">{account.accountName}</h4>
                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                      <span className={`text-[7px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 border rounded ${
                                        account.env === 'production' 
                                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                        : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                      }`}>
                                        {account.env === 'production' ? 'Live' : 'Demo'}
                                      </span>
                                      {account.accountBalance !== null && (
                                        <span className="text-[7px] font-extrabold uppercase tracking-widest px-1.5 py-0.5 border rounded bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                                          Bal: {formatAmount(account.accountBalance, 2)}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                
                                {/* Account Total Yield */}
                                <div className="text-right self-end sm:self-auto">
                                  <p className="text-[8px] text-gray-500 font-bold uppercase tracking-wider font-sans">Account Total Yield</p>
                                  <span className={`font-mono text-xs font-black ${account.totalAccountPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {account.totalAccountPnL >= 0 ? '+' : ''}{formatAmount(account.totalAccountPnL, 4)}
                                  </span>
                                </div>
                              </div>

                              {/* Nested Strategy Sections */}
                              <div className="flex flex-col gap-6 divide-y divide-white/[0.03]">
                                {account.strategies.map((strat, sIdx) => {
                                  return (
                                    <div key={strat.strategyName} className={`flex flex-col gap-4 ${sIdx > 0 ? 'pt-5' : ''}`}>
                                      {/* Strategy Header */}
                                      <div className="flex justify-between items-center bg-white/[0.01] px-3 py-1.5 rounded-lg border border-white/[0.03]">
                                        <span className="text-[9px] font-extrabold uppercase tracking-widest text-indigo-400 font-sans">
                                          Strategy: {strat.strategyName.toUpperCase()}
                                        </span>
                                        <div className="flex items-center gap-1.5 font-mono text-[10px]">
                                          <span className="text-gray-500 text-[8px] uppercase font-sans font-bold">Yield:</span>
                                          <span className={`font-bold ${strat.strategyPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {strat.strategyPnL >= 0 ? '+' : ''}{formatAmount(strat.strategyPnL, 4)}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Strangle Legs */}
                                      <div className="flex flex-col gap-4">
                                        {strat.stranglePairs.map((pair, idx) => {
                                          const callEntry = parseFloat(pair.call.entry_price) || 0
                                          const putEntry = parseFloat(pair.put.entry_price) || 0
                                          const callExit = parseFloat(pair.call.mark_price) || 0
                                          const putExit = parseFloat(pair.put.mark_price) || 0
                                          
                                          const callPnL = parseFloat(pair.call.pnl) || 0
                                          const putPnL = parseFloat(pair.put.pnl) || 0
                                          
                                          return (
                                            <div key={idx} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                              {[
                                                { leg: pair.call, entry: callEntry, exit: callExit, pnl: callPnL, isCall: true },
                                                { leg: pair.put, entry: putEntry, exit: putExit, pnl: putPnL, isCall: false }
                                              ].map((l, lIdx) => (
                                                <div key={lIdx} className="bg-black/10 p-4 rounded-xl border border-white/[0.02] flex flex-col gap-2 relative">
                                                  <div className="flex justify-between items-center border-b border-white/5 pb-2">
                                                    <div className="flex items-center gap-2">
                                                      <span className="font-extrabold text-white text-xs font-mono">{l.leg.symbol}</span>
                                                      <span className={`px-1.5 py-0.5 rounded text-[7px] font-bold uppercase tracking-widest border ${
                                                        l.isCall 
                                                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                                        : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                                                      }`}>
                                                        {l.isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                                      </span>
                                                    </div>
                                                    <span className={`font-mono text-xs font-bold ${l.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                      {l.pnl >= 0 ? '+' : ''}{formatAmount(l.pnl, 4)}
                                                    </span>
                                                  </div>

                                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-1 text-[9px] font-mono text-gray-400">
                                                    <div className="flex flex-col">
                                                      <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Entry</span>
                                                      <span className="text-gray-300 font-bold mt-0.5">${l.entry.toFixed(2)}</span>
                                                      <span className="text-[7px] text-gray-600 mt-0.5">{formatDateTime(l.leg.created_at)}</span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                      <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Exit</span>
                                                      <span className="text-gray-300 font-bold mt-0.5">${l.exit.toFixed(2)}</span>
                                                      <span className="text-[7px] text-gray-600 mt-0.5">{formatDateTime(l.leg.closed_at)}</span>
                                                    </div>
                                                    <div className="flex flex-col col-span-2 sm:col-span-1">
                                                      <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Risk / Limits</span>
                                                      <span className="text-rose-400 font-semibold mt-0.5">SL: ${parseFloat(l.leg.sl_price || 0).toFixed(2)}</span>
                                                      <span className="text-emerald-400 font-semibold mt-0.5">
                                                        {l.leg.strategy_name === 'decay2' ? `TP: $${parseFloat(l.leg.tp_price || 0).toFixed(2)}` : `Spot Target: $${parseFloat(l.leg.tp_price || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
                                                      </span>
                                                      {l.leg.strategy_name === 'decay1' && l.leg.tp_price > 0 && (
                                                        <span className="text-cyan-400 font-semibold mt-0.5">
                                                          Entry Spot: ${(l.isCall ? l.leg.tp_price / 0.9925 : l.leg.tp_price / 1.0075).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                                                        </span>
                                                      )}
                                                    </div>
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          )
                                        })}

                                        {strat.unpaired.map((leg, idx) => {
                                          const isCall = leg.symbol.startsWith('C-')
                                          const entryPrice = parseFloat(leg.entry_price) || 0
                                          const exitPrice = parseFloat(leg.mark_price) || 0
                                          const legPnL = parseFloat(leg.pnl) || 0

                                          return (
                                            <div key={idx} className="bg-black/10 p-4 rounded-xl border border-white/[0.02] flex flex-col gap-2 relative">
                                              <div className="flex justify-between items-center border-b border-white/5 pb-2">
                                                <div className="flex items-center gap-2">
                                                  <span className="font-extrabold text-white text-xs font-mono">{leg.symbol}</span>
                                                  <span className={`px-1.5 py-0.5 rounded text-[7px] font-bold uppercase tracking-widest border ${
                                                    isCall 
                                                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                                    : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                                                  }`}>
                                                    {isCall ? 'CALL SHORT' : 'PUT SHORT'}
                                                  </span>
                                                  <span className="px-1.5 py-0.5 rounded text-[7px] font-bold uppercase bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                                    UNPAIRED
                                                  </span>
                                                </div>
                                                <span className={`font-mono text-xs font-bold ${legPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                  {legPnL >= 0 ? '+' : ''}{formatAmount(legPnL, 4)}
                                                </span>
                                              </div>

                                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-1 text-[9px] font-mono text-gray-400">
                                                <div className="flex flex-col">
                                                  <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Entry</span>
                                                  <span className="text-gray-300 font-bold mt-0.5">${entryPrice.toFixed(2)}</span>
                                                  <span className="text-[7px] text-gray-600 mt-0.5">{formatDateTime(leg.created_at)}</span>
                                                </div>
                                                <div className="flex flex-col">
                                                  <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Exit</span>
                                                  <span className="text-gray-300 font-bold mt-0.5">${exitPrice.toFixed(2)}</span>
                                                  <span className="text-[7px] text-gray-600 mt-0.5">{formatDateTime(leg.closed_at)}</span>
                                                </div>
                                                <div className="flex flex-col col-span-2 sm:col-span-1">
                                                  <span className="text-[8px] text-gray-500 uppercase font-sans tracking-wider">Risk / Limits</span>
                                                  <span className="text-rose-400 font-semibold mt-0.5">SL: ${parseFloat(leg.sl_price || 0).toFixed(2)}</span>
                                                  <span className="text-emerald-400 font-semibold mt-0.5">
                                                    {leg.strategy_name === 'decay2' ? `TP: $${parseFloat(leg.tp_price || 0).toFixed(2)}` : `Spot Target: $${parseFloat(leg.tp_price || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
                                                  </span>
                                                  {leg.strategy_name === 'decay1' && leg.tp_price > 0 && (
                                                    <span className="text-cyan-400 font-semibold mt-0.5">
                                                      Entry Spot: ${(isCall ? leg.tp_price / 0.9925 : leg.tp_price / 1.0075).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                                                    </span>
                                                  )}
                                                </div>
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

            </div>

            {/* TRADING ACCOUNTS */}
            <div className={`transition-all duration-350 ease-in-out transform flex flex-col gap-6 ${
              activeTab === 'accounts' 
              ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
              : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-0 top-0 z-0'
            }`}>
                
                <div className="flex flex-col sm:flex-row justify-between sm:items-center border-b border-white/[0.04] pb-4.5 gap-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white tracking-wide">Linked API Credentials</h3>
                    <div className="tooltip-trigger">
                      <Info className="w-3.5 h-3.5 text-gray-500 hover:text-indigo-400 cursor-help transition-colors" />
                      <span className="tooltip-content">
                        Secure execution layers connecting to Delta Exchange API portal.
                      </span>
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => setShowAddAccountModal(true)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-gray-50 text-xs font-semibold tracking-wider transition-all duration-300 shadow-[0_4px_12px_rgba(79,70,229,0.15)] focus:outline-none focus:ring-0"
                  >
                    <UserPlus className="w-4 h-4" />
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
                  <div className="flex flex-col gap-8">
                    {/* ACTIVE ACCOUNTS SECTION */}
                    {accounts.filter(a => a.is_active).length > 0 && (
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.4)]" />
                          <h3 className="text-[10px] text-emerald-400 font-mono font-bold uppercase tracking-widest">
                            Active Trading Accounts ({accounts.filter(a => a.is_active).length})
                          </h3>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {accounts.filter(a => a.is_active).map(acc => {
                            return (
                              <div key={acc.id} className="glass-card rounded-xl p-4 flex flex-col justify-between border border-white/5 hover:border-cyan-500/10 transition-all duration-300 relative overflow-hidden min-h-[135px]">
                                <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${
                                  acc.env === 'production' 
                                  ? 'from-amber-400 to-amber-600' 
                                  : 'from-cyan-400 to-indigo-500'
                                }`}></div>
                                <div className="flex justify-between items-start gap-2">
                                  <div className="min-w-0">
                                    <h4 className="font-extrabold text-white text-sm tracking-tight truncate">{(acc.name || '').split('|')[0]}</h4>
                                    <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[7px] font-extrabold uppercase tracking-widest border ${
                                      acc.env === 'production' 
                                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                      : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                    }`}>
                                      {acc.env === 'production' ? 'Live' : 'Demo'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[7px] font-extrabold uppercase tracking-widest font-sans shrink-0">
                                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                                    <span>Active</span>
                                  </div>
                                </div>
                                <div className="my-3 flex flex-col">
                                  <span className="text-[7px] text-gray-500 uppercase font-sans tracking-widest">Available Balance</span>
                                  <span className="text-white font-mono text-base font-extrabold mt-0.5">
                                    {formatAmount((acc.name || '').split('|')[1] ? parseFloat((acc.name || '').split('|')[1]) : 10000.0, 2)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between border-t border-white/5 pt-3 mt-1">
                                  <span className="text-[7px] text-gray-500 font-mono">Delta India</span>
                                  <div className="flex items-center gap-1.5">
                                    <button 
                                      onClick={() => handleToggleAccount(acc.id, acc.is_active)}
                                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[9px] font-extrabold uppercase tracking-wider transition-all duration-300 focus:outline-none focus:ring-0 bg-rose-500/15 border-rose-500/25 text-rose-400 hover:bg-rose-600 hover:text-white hover:border-rose-600"
                                      title="Disable Account Execution"
                                    >
                                      <Power className="w-2.5 h-2.5" />
                                      <span>Disable</span>
                                    </button>
                                    <button 
                                      onClick={() => handleDeleteAccount(acc.id)}
                                      className="p-1.5 rounded-lg bg-rose-500/5 hover:bg-rose-500/20 text-rose-400 border border-rose-500/10 hover:border-rose-500/30 transition-all duration-300 flex items-center justify-center focus:outline-none focus:ring-0"
                                      title="Remove Credentials"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* PAUSED ACCOUNTS SECTION */}
                    {accounts.filter(a => !a.is_active).length > 0 && (
                      <div className="flex flex-col gap-4 mt-2">
                        <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.4)]" />
                          <h3 className="text-[10px] text-rose-400 font-mono font-bold uppercase tracking-widest">
                            Paused Trading Accounts ({accounts.filter(a => !a.is_active).length})
                          </h3>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {accounts.filter(a => !a.is_active).map(acc => {
                            return (
                              <div key={acc.id} className="glass-card rounded-xl p-4 flex flex-col justify-between border border-white/5 hover:border-cyan-500/10 transition-all duration-300 relative overflow-hidden opacity-75 hover:opacity-100 min-h-[135px]">
                                <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${
                                  acc.env === 'production' 
                                  ? 'from-amber-400 to-amber-600' 
                                  : 'from-cyan-400 to-indigo-500'
                                }`}></div>
                                <div className="flex justify-between items-start gap-2">
                                  <div className="min-w-0">
                                    <h4 className="font-extrabold text-white text-sm tracking-tight truncate">{(acc.name || '').split('|')[0]}</h4>
                                    <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[7px] font-extrabold uppercase tracking-widest border ${
                                      acc.env === 'production' 
                                      ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                                      : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                    }`}>
                                      {acc.env === 'production' ? 'Live' : 'Demo'}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1.5 py-0.5 rounded text-[7px] font-extrabold uppercase tracking-widest font-sans shrink-0">
                                    <span className="w-1 h-1 rounded-full bg-rose-400" />
                                    <span>Paused</span>
                                  </div>
                                </div>
                                <div className="my-3 flex flex-col">
                                  <span className="text-[7px] text-gray-500 uppercase font-sans tracking-widest">Available Balance</span>
                                  <span className="text-white font-mono text-base font-extrabold mt-0.5">
                                    {formatAmount((acc.name || '').split('|')[1] ? parseFloat((acc.name || '').split('|')[1]) : 10000.0, 2)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between border-t border-white/5 pt-3 mt-1">
                                  <span className="text-[7px] text-gray-500 font-mono">Delta India</span>
                                  <div className="flex items-center gap-1.5">
                                    <button 
                                      onClick={() => handleToggleAccount(acc.id, acc.is_active)}
                                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[9px] font-extrabold uppercase tracking-wider transition-all duration-300 focus:outline-none focus:ring-0 bg-emerald-500/15 border-emerald-500/25 text-emerald-400 hover:bg-emerald-600 hover:text-white hover:border-emerald-600"
                                      title="Enable Account Execution"
                                    >
                                      <Power className="w-2.5 h-2.5" />
                                      <span>Enable</span>
                                    </button>
                                    <button 
                                      onClick={() => handleDeleteAccount(acc.id)}
                                      className="p-1.5 rounded-lg bg-rose-500/5 hover:bg-rose-500/20 text-rose-400 border border-rose-500/10 hover:border-rose-500/30 transition-all duration-300 flex items-center justify-center focus:outline-none focus:ring-0"
                                      title="Remove Credentials"
                                    >
                                      <Trash2 className="w-3 h-3" />
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
                )}
              </div>

            {/* STRATEGY PARAMETERS - SEPARATED CARDS */}
            <div 
              className={`transition-all duration-350 ease-in-out transform grid grid-cols-1 xl:grid-cols-2 gap-8 w-full max-w-7xl ${
                activeTab === 'config' 
                ? 'visible opacity-100 translate-y-0 scale-100 pointer-events-auto relative z-10' 
                : 'invisible opacity-0 translate-y-4 scale-[0.98] pointer-events-none absolute inset-x-0 top-0 z-0'
              }`}
            >
              {strategiesList.map(strat => {
                const isDecay2 = strat.name === 'decay2'
                const currentSL = formValues[`${strat.name}_sl`] ?? strat.sl_multiplier
                const currentTarget = formValues[`${strat.name}_target`] ?? strat.underlying_target_pct

                const getSLPercent = (val) => {
                  const num = parseFloat(val)
                  if (isNaN(num)) return '0'
                  return ((num - 1) * 100).toFixed(0)
                }

                const getTargetPercent = (val, isD2) => {
                  const num = parseFloat(val)
                  if (isNaN(num)) return '0'
                  return (num * 100).toFixed(isD2 ? 0 : 2)
                }

                const formatTimeForInput = (timeStr) => {
                  if (!timeStr) return ""
                  return timeStr.slice(0, 5)
                }

                return (
                  <form 
                    key={strat.id}
                    onSubmit={handleUpdateConfigForStrategy(strat)} 
                    className="flex flex-col gap-6 bg-black/10 p-6 rounded-2xl border border-white/5 h-fit"
                  >
                    <div className="border-b border-white/[0.04] pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-base font-bold text-white tracking-wide">{strat.name.toUpperCase()} Option Parameters</h3>
                          <div className="tooltip-trigger">
                            <Info className="w-3.5 h-3.5 text-gray-500 hover:text-indigo-400 cursor-help transition-colors" />
                            <span className="tooltip-content">
                              {!isDecay2 
                                ? 'Fine-tune decay boundaries and underlying asset index move guard rails.' 
                                : 'Configure short strangle with native bracket stop loss and take profit.'}
                            </span>
                          </div>
                          {strat.is_active ? (
                            <div className="flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest font-sans">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              <span>Active</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 bg-rose-500/10 text-rose-400 border border-rose-500/20 px-1.5 py-0.5 rounded text-[8px] font-extrabold uppercase tracking-widest font-sans">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                              <span>Paused</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 self-start sm:self-auto shrink-0">
                        <button
                          type="button"
                          onClick={() => handleToggleStrategyForObject(strat)}
                          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-[10px] font-extrabold uppercase tracking-wider transition-all duration-300 focus:outline-none focus:ring-0 ${
                            strat.is_active
                              ? 'bg-rose-500/15 border-rose-500/25 text-rose-400 hover:bg-rose-600 hover:text-white hover:border-rose-600 shadow-[0_0_12px_rgba(239,68,68,0.1)]'
                              : 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400 hover:bg-emerald-600 hover:text-white hover:border-emerald-600 shadow-[0_0_12px_rgba(16,185,129,0.1)]'
                          }`}
                        >
                          {strat.is_active ? (
                            <>
                              <Pause className="w-3.5 h-3.5" />
                              Pause Strategy
                            </>
                          ) : (
                            <>
                              <Play className="w-3.5 h-3.5" />
                              Enable Strategy
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    
                    {/* Time range parameters */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">Entry Time (IST)</label>
                            <div className="tooltip-trigger">
                              <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                              <span className="tooltip-content">
                                Time of day (IST) when the bot starts placing options strangle legs on the exchange.
                              </span>
                            </div>
                          </div>
                        </div>
                        <input 
                          type="time" 
                          name="entry_time" 
                          value={formatTimeForInput(formValues[`${strat.name}_entry`] ?? strat.entry_time_ist)} 
                          onChange={(e) => handleFieldChange(strat.name, 'entry', e.target.value)}
                          className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold [color-scheme:dark] w-full"
                        />
                      </div>
                      
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">Exit Time (IST)</label>
                            <div className="tooltip-trigger">
                              <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                              <span className="tooltip-content">
                                Hard intraday session square-off time (IST) to close out options strangle positions.
                              </span>
                            </div>
                          </div>
                        </div>
                        <input 
                          type="time" 
                          name="exit_time" 
                          value={formatTimeForInput(formValues[`${strat.name}_exit`] ?? strat.exit_time_ist)} 
                          onChange={(e) => handleFieldChange(strat.name, 'exit', e.target.value)}
                          className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold [color-scheme:dark] w-full"
                        />
                      </div>
                    </div>

                    {/* Risk boundaries */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">Stop Loss (SL) Multiplier</label>
                          <div className="tooltip-trigger">
                            <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                            <span className="tooltip-content">
                              Multiplier applied to entry premium. E.g. 1.40 means a hard stop-loss trigger at 40% loss on a per-leg basis.
                            </span>
                          </div>
                        </div>
                        <input 
                          type="number" 
                          step="0.05"
                          name="sl_multiplier" 
                          value={formValues[`${strat.name}_sl`] ?? strat.sl_multiplier} 
                          onChange={(e) => handleFieldChange(strat.name, 'sl', e.target.value)}
                          className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold"
                        />
                        <div className="flex items-center justify-between px-1.5 mt-0.5">
                          <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider font-sans">Computed Limit</span>
                          <span className="text-[9px] text-rose-400 font-extrabold uppercase tracking-widest bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20 font-mono">
                            {getSLPercent(currentSL)}% SL Leg limit
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">
                            {isDecay2 ? 'Take Profit (TP) Multiplier' : 'Favorable Spot Target (%)'}
                          </label>
                          <div className="tooltip-trigger">
                            <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                            <span className="tooltip-content">
                              {isDecay2 
                                ? 'Premium target multiplier (e.g. 0.50 triggers take-profit when options premium decays by 50%).' 
                                : 'Spot target percentage. If the underlying asset moves by this percentage in either direction, both legs close.'}
                            </span>
                          </div>
                        </div>
                        <input 
                          type="number" 
                          step={isDecay2 ? '0.05' : '0.0005'}
                          name="target_pct" 
                          value={formValues[`${strat.name}_target`] ?? strat.underlying_target_pct} 
                          onChange={(e) => handleFieldChange(strat.name, 'target', e.target.value)}
                          className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold"
                        />
                        <div className="flex items-center justify-between px-1.5 mt-0.5">
                          <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider font-sans">Computed Limit</span>
                          <span className="text-[9px] text-emerald-400 font-extrabold uppercase tracking-widest bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-mono">
                            {isDecay2 
                              ? `${getTargetPercent(currentTarget, true)}% Premium TP Limit` 
                              : `${getTargetPercent(currentTarget, false)}% Spot Move Limit`}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Strike Selection & Monitored Index */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">Strike Selection (OTM)</label>
                          <div className="tooltip-trigger">
                            <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                            <span className="tooltip-content">
                              Selects how far Out-Of-The-Money options are picked. OTM1 is closest to spot (high premium & liquidity); OTM6 is furthest out (cheap premium & illiquid).
                            </span>
                          </div>
                        </div>
                        <select 
                          name="strike_selection" 
                          value={formValues[`${strat.name}_strike`] ?? strat.strike_selection ?? "otm6"} 
                          onChange={(e) => handleFieldChange(strat.name, 'strike', e.target.value)}
                          className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold cursor-pointer"
                        >
                          <option value="otm1">OTM 1 (High Liquidity / Premium)</option>
                          <option value="otm2">OTM 2 (Medium High)</option>
                          <option value="otm3">OTM 3 (Medium)</option>
                          <option value="otm4">OTM 4 (Medium Low)</option>
                          <option value="otm5">OTM 5 (Low)</option>
                          <option value="otm6">OTM 6 (Deep OTM / Cheap)</option>
                        </select>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest font-sans">Monitored Index</label>
                          <div className="tooltip-trigger">
                            <Info className="w-3 h-3 text-gray-500 hover:text-cyan-400 cursor-help transition-colors" />
                            <span className="tooltip-content">
                              The underlying asset index monitored for strategy calculations.
                            </span>
                          </div>
                        </div>
                        <input 
                          type="text" 
                          disabled
                          defaultValue={strat.underlying} 
                          className="bg-[#070b13] border border-white/5 rounded-xl px-4 py-3 text-sm text-gray-500 font-extrabold focus:outline-none cursor-not-allowed font-sans tracking-wide"
                        />
                      </div>
                    </div>

                    <div className="bg-cyan-500/5 p-4 rounded-xl border border-cyan-500/10 flex gap-3 items-start mt-2">
                      <Info className="w-5.5 h-5.5 text-cyan-400 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-gray-400 leading-relaxed">
                        <p className="font-bold text-gray-300">Intraday Safety Protections Armed:</p>
                        <p className="mt-1">
                          1. Hard Intraday time exit halts strangle positions at <strong>{strat.exit_time_ist} IST</strong> to prevent overnight gap risks.
                        </p>
                        {isDecay2 ? (
                          <p className="mt-0.5">
                            2. Native exchange stop loss at <strong>{strat.sl_multiplier}x</strong> entry premium and native take profit at <strong>{strat.underlying_target_pct}x</strong> entry premium.
                          </p>
                        ) : (
                          <p className="mt-0.5">
                            2. If the underlying index hits the <strong>{(strat.underlying_target_pct * 100).toFixed(2)}%</strong> spot target for an option leg, only that specific leg closes immediately.
                          </p>
                        )}
                      </div>
                    </div>

                    <button 
                      type="submit"
                      className="w-full py-3 mt-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-gray-50 font-semibold tracking-wider text-xs transition duration-300 shadow-[0_4px_12px_rgba(79,70,229,0.15)] focus:outline-none focus:ring-0"
                    >
                      Save Configuration
                    </button>
                  </form>
                )
              })}
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
              <span className="hidden md:inline text-[10px] text-gray-500 font-sans truncate max-w-lg">
                Latest: {logs[0].strategy_name ? `[${logs[0].strategy_name.toUpperCase()}] ` : ''}{logs[0].message}
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
                      <span className="text-gray-500 shrink-0 font-semibold">
                        {log.account_name || 'SYSTEM'}
                        {log.strategy_name && (
                          <span className="text-[9px] text-cyan-400/80 font-bold ml-1 uppercase">
                            ({log.strategy_name})
                          </span>
                        )}:
                      </span>
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
            <div className="absolute top-0 left-0 right-0 h-1 bg-indigo-600"></div>
            
            <h3 className="text-lg font-bold text-white tracking-wide">Link Delta India Client API</h3>
            <p className="text-[11px] text-gray-500 -mt-1.5">Credentials are authenticated via standard HMAC-SHA256 protocol on-device.</p>
            
            <form onSubmit={handleAddAccount} className="flex flex-col gap-4.5 mt-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-sans">Account Tag Label</label>
                <input 
                  type="text" 
                  value={accName} 
                  onChange={e => setAccName(e.target.value)}
                  placeholder="e.g. Primary Strangle Account" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-sans">Delta API Key</label>
                <input 
                  type="text" 
                  value={accKey} 
                  onChange={e => setAccKey(e.target.value)}
                  placeholder="Paste public API key" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-sans">Delta API Secret</label>
                <input 
                  type="password" 
                  value={accSecret} 
                  onChange={e => setAccSecret(e.target.value)}
                  placeholder="Paste private API secret key" 
                  required
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-bold text-gray-400 uppercase tracking-widest font-sans">Environment Type</label>
                <select 
                  value={accEnv} 
                  onChange={e => setAccEnv(e.target.value)}
                  className="bg-[#05070e] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition duration-200 font-sans font-semibold"
                >
                  <option value="testnet">Testnet Sandbox (Demo Accounts)</option>
                  <option value="production">Production Live Desk (Real Money)</option>
                </select>
              </div>

              <div className="flex gap-3 justify-end mt-4">
                <button 
                  type="button" 
                  onClick={() => setShowAddAccountModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white uppercase tracking-wider transition font-sans focus:outline-none focus:ring-0"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold uppercase tracking-wider rounded-xl transition duration-300 shadow-[0_4px_12px_rgba(79,70,229,0.15)] focus:outline-none focus:ring-0"
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
            <div className="absolute top-0 left-0 right-0 h-1 bg-rose-600"></div>
            
            <div className="mx-auto w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 shadow-[0_0_15px_rgba(239,68,68,0.1)]">
              <AlertTriangle className="w-6 h-6" />
            </div>
            
            <div>
              <h3 className="text-lg font-bold text-white tracking-wide">{showConfirmModal.title}</h3>
              <p className="text-xs text-gray-400 mt-3 leading-relaxed font-sans">
                {showConfirmModal.message}
              </p>
              <div className="mt-4 bg-rose-950/20 p-3 rounded-xl border border-rose-500/15 text-[10px] text-rose-400 font-bold uppercase tracking-wider font-sans">
                WARNING: Slippage may occur during high-volatility events.
              </div>
            </div>
            
            <div className="flex gap-3 justify-center mt-3.5">
              <button 
                onClick={() => setShowConfirmModal(null)}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-400 hover:text-white uppercase tracking-wider transition font-sans focus:outline-none focus:ring-0"
              >
                Cancel
              </button>
              <button 
                onClick={handleEmergencyClose}
                className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold uppercase tracking-wider rounded-xl transition duration-300 shadow-[0_4px_12px_rgba(239,68,68,0.15)] focus:outline-none focus:ring-0"
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
