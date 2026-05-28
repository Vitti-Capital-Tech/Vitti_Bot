# DeltaTrade: Option Strangle Execution Desk

Welcome to DeltaTrade. This platform is a professional, automated trading system designed to execute and monitor options strangle strategies on Delta Exchange India. 

The software runs in the background to place trades and manage risk automatically, while the web dashboard serves as a control room to view active performance, link trading accounts, and adjust strategy parameters.

---

## 1. What is an Option Strangle?

An Option Strangle is a trading strategy used when a trader believes an asset (such as Bitcoin) will stay within a certain price boundary for the day. 

To execute a strangle, the system simultaneously sells two out-of-the-money insurance-like contracts:
1.  **Short Call**: A contract that pays out as long as the asset price does not surge above a high price ceiling.
2.  **Short Put**: A contract that pays out as long as the asset price does not drop below a low price floor.

By selling both contracts, you collect cash up front (called **premium**). As long as the asset price stays between the floor and the ceiling, these contracts decay in value over the course of the day, allowing the system to keep the collected cash as profit.

---

## 2. How the Automation Works

The system operates automatically on weekdays using a pre-configured strategy called **Decay1**:

1.  **Automatic Trade Entry (08:31 AM IST)**: The background engine checks the current market price of Bitcoin. It instantly selects contracts that are far away from the current price (6 strikes away from the market price) and enters the short strangle trades.
2.  **Continuous Monitoring (Every 10 Seconds)**: The system checks market prices every 10 seconds.
    *   **Stop-Loss Protection**: If the value of either contract rises by 40% (which means that trade is losing money), the system automatically closes that specific contract to prevent further losses.
    *   **Market Move Protection**: If the underlying price of Bitcoin shifts by 0.75% in either direction, the system immediately exits both contracts to protect capital.
3.  **Automatic Trade Exit (12:29 PM IST)**: At the end of the session, the system automatically buys back all open contracts to ensure no trades are left open overnight, securing the day's earnings.

---

## 3. How to Use the Dashboard Control Panel

The web terminal provides three clear work areas:

*   **Active Strangles Tab**: Displays current active positions. It features a unified profit summary and a visual Premium Decay Progress Bar. The bar glows green as profit accumulates (premiums decay) and shifts to red if premiums inflate. You can click "Square Off Strangle" to exit both contracts instantly in one click.
*   **Trading Accounts Tab**: Allows you to connect or disconnect your exchange API credentials. It supports both Testnet (demo account with virtual funds) and Production (real money) environments.
*   **Decay1 Parameters Tab**: Allows you to customize strategy timings, stop-loss ratios, and movement thresholds without touching code.
*   **Live Database Console**: A collapsible terminal panel located at the bottom of the page. It remains closed to keep the view clean but can be opened in one click to view live execution logs and transaction events.

---

## 4. Associated Documentation Links

Below are the core documentation resources of the strangle trading desk. You can click on any document to open and view it directly on GitHub:

*   [High-Level Architecture Design (HLD.md)](docs/HLD.md): Simplified diagrams and block explanations of how the UI, database, and bot daemon interact.
*   [Low-Level Technical Design (LLD.md)](docs/LLD.md): Database structures, cryptographic signatures, and state-machine transition charts.
*   [Proprietary License File (LICENSE)](LICENSE): The proprietary copyright agreement for Vitti Capital.
