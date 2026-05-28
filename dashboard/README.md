# DeltaTrade Web Dashboard

This directory houses the frontend web dashboard for the DeltaTrade automated options strangle desk. It is a highly responsive, premium, glassmorphic trading terminal designed to connect directly with your Supabase database.

---

## 1. Features
*   **Active Strangle Workspace**: Groups separate trading positions into clean Strangle Sets per account, presenting consolidated strangle prices and unified PnL calculations.
*   **Strangle Premium Decay Meter**: A hardware-accelerated visual progress bar indicating percentage option decay (profit zone) or inflation (loss zone).
*   **Emergency Dual Exit Panel**: Allows closing both legs of a strangle concurrently to minimize slippage, as well as single-leg close operations.
*   **Connected API Server Nodes**: Credit-card style glass card displays representing enabled/disabled accounts with environment tags.
*   **Live Database Console**: A collapsible developer terminal drawer at the bottom of the viewport streaming transaction and scheduling events in real-time.

---

## 2. Technology Stack
*   **Framework**: React (Vite environment)
*   **Styling**: Tailwind CSS v4 and Vanilla CSS tokens
*   **Database Sync**: Supabase JS client with PostgreSQL real-time socket listeners
*   **Icons**: Lucide React

---

## 3. Local Installation & Development

To run the dashboard locally on your development machine:

1.  Navigate into the `dashboard` directory:
    ```bash
    cd dashboard
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create a `.env` file in the `dashboard` folder containing:
    ```env
    VITE_SUPABASE_URL=your-supabase-project-url
    VITE_SUPABASE_ANON_KEY=your-anon-public-key
    ```
4.  Launch the development server:
    ```bash
    npm run dev
    ```
5.  Open `http://localhost:5173` in your browser.

---

## 4. Production Deployment to Vercel

The dashboard is fully optimized for serverless hosting on Vercel:

1.  Connect your GitHub repository to Vercel.
2.  Select `dashboard` as the project's **Root Directory**.
3.  Under project settings, configure the following **Environment Variables**:
    *   `VITE_SUPABASE_URL`: Your Supabase connection URL.
    *   `VITE_SUPABASE_ANON_KEY`: Your Supabase anonymous public key.
4.  Click deploy. Vercel will host the dashboard globally.

---

## 5. Associated Documentation

You can reference the following documentation using these relative links:
*   [Root Workspace Guide](../README.md): Simplified explanation of the strangle strategy and daemon.
*   [High-Level Design Document (HLD)](../docs/HLD.md): Diagrammatic flows of user components and operational timelines.
*   [Low-Level Design Document (LLD)](../docs/LLD.md): Mathematical strike algorithms, database relations, and API security signatures.
*   [Proprietary License File](../LICENSE): Proprietary copyright conditions for Vitti Capital.
