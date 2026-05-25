use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState;
use anchor_lang::AccountDeserialize;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("BUzLPyNSfEGnKY3RozDtny4us72bYPbiCq2njQLjtaff");

#[cfg(not(feature = "no-entrypoint"))]
macro_rules! security_txt {
    ($($name:ident: $value:expr),* $(,)?) => {
        #[cfg_attr(
            any(target_arch = "bpf", target_arch = "sbf", target_os = "solana"),
            link_section = ".security.txt"
        )]
        #[allow(dead_code)]
        #[used]
        #[no_mangle]
        pub static SECURITY_TXT: &str = concat! {
            "=======BEGIN SECURITY.TXT V1=======\0",
            $(stringify!($name), "\0", $value, "\0",)*
            "=======END SECURITY.TXT V1=======\0"
        };
    };
}

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Istina Contest Program",
    project_url: "https://istina.co",
    contacts: "email:security@istina.co",
    policy: "https://istina.co/contact",
    preferred_languages: "en",
    source_code: "https://github.com/istina-dev/smart-contracts"
}

#[program]
pub mod contest {
    use super::*;

    /// Initialize the program with global configuration
    pub fn program_init(ctx: Context<ProgramInit>) -> Result<()> {
        // Prevent init-front-running by requiring the caller to be the program's upgrade authority.
        // This is the only on-chain identity we can reliably verify at init time.
        let program_data = ctx.accounts.program.try_borrow_data()?;
        let mut program_bytes: &[u8] = &program_data;
        let program_state = UpgradeableLoaderState::try_deserialize_unchecked(&mut program_bytes)?;

        let programdata_address = match program_state {
            UpgradeableLoaderState::Program { programdata_address } => programdata_address,
            _ => return err!(ContestError::InvalidProgramAccount),
        };

        require!(programdata_address == ctx.accounts.program_data.key(), ContestError::InvalidProgramData);

        // ProgramData account must be owned by the BPF upgradeable loader
        require!(
            ctx.accounts.program_data.to_account_info().owner
                == &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
            ContestError::InvalidProgramData
        );

        // Deserialize ProgramData state and require upgrade authority == admin signer
        let program_data_ai = ctx.accounts.program_data.to_account_info();
        let program_data_bytes = program_data_ai.try_borrow_data()?;
        let mut program_data_slice: &[u8] = &program_data_bytes;
        let program_data_state =
            UpgradeableLoaderState::try_deserialize_unchecked(&mut program_data_slice)?;

        let upgrade_authority = match program_data_state {
            UpgradeableLoaderState::ProgramData {
                slot: _,
                upgrade_authority_address,
            } => upgrade_authority_address,
            _ => return err!(ContestError::InvalidProgramData),
        };

        require!(
            upgrade_authority == Some(ctx.accounts.admin.key()),
            ContestError::Unauthorized
        );

        let global_config = &mut ctx.accounts.global_config;
        global_config.admin = ctx.accounts.admin.key();
        global_config.bump = ctx.bumps.global_config;
        
        msg!("Program initialized with admin: {}", global_config.admin);
        Ok(())
    }

    /// Create contest and fund atomically (one transaction)
    pub fn create_and_fund_contest(
        ctx: Context<CreateAndFundContest>,
        contest_id: u64,
        total_amount: u64,
        deadline: i64,
    ) -> Result<()> {
        // Validate inputs
        require!(total_amount > 0, ContestError::InvalidAmount);
        require!(
            deadline > Clock::get()?.unix_timestamp,
            ContestError::InvalidDeadline
        );
        
        let contest = &mut ctx.accounts.contest;
        let creator = &ctx.accounts.creator;
        
        // Initialize Contest PDA
        contest.creator = creator.key();
        contest.token_mint = ctx.accounts.token_mint.key();
        contest.deadline = deadline;
        contest.total_prize_pool = total_amount;
        contest.total_released = 0;
        contest.bump = ctx.bumps.contest;
        
        // Transfer USDC from creator to vault (atomic with contest creation)
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.creator_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: creator.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, total_amount)?;
        
        msg!(
            "Contest {} created and funded: {} tokens by {}",
            contest_id,
            total_amount,
            creator.key()
        );
        
        // Emit event
        emit!(ContestCreated {
            contest_pda: contest.key(),
            creator: creator.key(),
            total_amount,
            deadline,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        Ok(())
    }

    /// Release prize to winner (admin-only, flexible amount)
    pub fn release_prize(
        ctx: Context<ReleasePrize>,
        amount: u64,
    ) -> Result<()> {
        let admin = &ctx.accounts.admin;
        let global_config = &ctx.accounts.global_config;
        let contest = &mut ctx.accounts.contest;
        
        // 🔐 AUTHORIZATION: Only admin can release prizes
        require!(
            admin.key() == global_config.admin,
            ContestError::Unauthorized
        );
        
        // Validate amount
        require!(amount > 0, ContestError::InvalidAmount);
        
        // Validate vault has sufficient balance (automatic over-release prevention)
        let vault_balance = ctx.accounts.vault_token_account.amount;
        require!(
            vault_balance >= amount,
            ContestError::InsufficientFunds
        );

        // Enforce contest accounting invariants (prevents "over-release" even if someone
        // mistakenly transfers extra tokens into the vault).
        let new_total_released = contest
            .total_released
            .checked_add(amount)
            .ok_or(ContestError::Overflow)?;
        require!(
            new_total_released <= contest.total_prize_pool,
            ContestError::ExceedsPrizePool
        );
        
        // Transfer USDC from vault to winner
        let contest_key = contest.key();
        let vault_auth_bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault-authority",
            contest_key.as_ref(),
            &[vault_auth_bump],
        ]];
        
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.winner_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
        
        // Update tracking counter
        contest.total_released = new_total_released;
        
        msg!(
            "Prize released: {} tokens to {} (total released: {}/{})",
            amount,
            ctx.accounts.winner.key(),
            contest.total_released,
            contest.total_prize_pool
        );
        
        // Emit event
        emit!(PrizeReleased {
            contest_pda: contest.key(),
            winner: ctx.accounts.winner.key(),
            amount,
            total_released: contest.total_released,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        Ok(())
    }

    /// Refund to creator (admin-only, flexible amount)
    pub fn refund(
        ctx: Context<Refund>,
        amount: u64,
    ) -> Result<()> {
        let admin = &ctx.accounts.admin;
        let global_config = &ctx.accounts.global_config;
        
        // 🔐 AUTHORIZATION: Only admin can refund
        require!(
            admin.key() == global_config.admin,
            ContestError::Unauthorized
        );
        
        // Validate amount
        require!(amount > 0, ContestError::InvalidAmount);
        
        // Validate vault has sufficient balance (automatic over-refund prevention)
        let vault_balance = ctx.accounts.vault_token_account.amount;
        require!(
            vault_balance >= amount,
            ContestError::InsufficientFunds
        );
        
        // Transfer USDC from vault to creator
        let contest_key = ctx.accounts.contest.key();
        let vault_auth_bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault-authority",
            contest_key.as_ref(),
            &[vault_auth_bump],
        ]];
        
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
        
        let contest = &ctx.accounts.contest;
        
        msg!(
            "Refunded: {} tokens to creator {}",
            amount,
            contest.creator
        );
        
        // Emit event
        emit!(ContestRefunded {
            contest_pda: contest.key(),
            creator: contest.creator,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        Ok(())
    }

    /// Close contest (admin-only, vault must be empty)
    pub fn close_contest(ctx: Context<CloseContest>) -> Result<()> {
        let admin = &ctx.accounts.admin;
        let global_config = &ctx.accounts.global_config;
        
        // 🔐 AUTHORIZATION: Only admin can close
        require!(
            admin.key() == global_config.admin,
            ContestError::Unauthorized
        );
        
        // Validate vault is empty (safety check)
        let vault_balance = ctx.accounts.vault_token_account.amount;
        require!(vault_balance == 0, ContestError::VaultNotEmpty);
        
        let contest = &ctx.accounts.contest;
        let contest_id = contest.key();
        let vault_auth_bump = ctx.bumps.vault_authority;
        
        // 🔒 Close vault token account and reclaim rent to admin
        // We must use SPL Token's close_account instruction because ATAs are owned by the Token Program
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault-authority",
            contest_id.as_ref(),
            &[vault_auth_bump],
        ]];
        
        let close_account_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ctx.accounts.vault_token_account.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(), // Rent reclaimed to admin
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_account_ctx)?;
        
        msg!("Contest closed, vault rent reclaimed to admin");
        
        // Emit event
        emit!(ContestClosed {
            contest_pda: contest.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        // The Contest PDA itself will be closed automatically via the `close = admin` constraint
        Ok(())
    }

    /// Update admin to new address (typically Squads Vault 0)
    /// One-time operation to migrate from hot wallet to multisig
    /// Only current admin can update to new admin
    pub fn update_admin(ctx: Context<UpdateAdmin>) -> Result<()> {
        let admin = &ctx.accounts.admin;
        let global_config = &mut ctx.accounts.global_config;
        let new_admin = &ctx.accounts.new_admin;
        
        // 🔐 AUTHORIZATION: Only current admin can update
        require!(
            admin.key() == global_config.admin,
            ContestError::Unauthorized
        );
        
        // Prevent setting to null/default pubkey
        require!(
            new_admin.key() != Pubkey::default(),
            ContestError::InvalidNewAdmin
        );
        
        let old_admin = global_config.admin;
        global_config.admin = new_admin.key();
        
        emit!(AdminUpdated {
            old_admin,
            new_admin: new_admin.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        msg!(
            "Admin updated from {} to {}",
            old_admin,
            new_admin.key()
        );
        Ok(())
    }
}

// ==================== ACCOUNT STRUCTURES ====================

#[derive(Accounts)]
pub struct ProgramInit<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: The currently executing program account (used to verify upgrade authority)
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,

    /// CHECK: ProgramData account for this program (owned by the BPF upgradeable loader)
    pub program_data: UncheckedAccount<'info>,
    
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 1,  // Discriminator + Pubkey + u8
        seeds = [b"global-config"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(contest_id: u64)]
pub struct CreateAndFundContest<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    
    /// Platform fee payer / admin - funds rent + transaction fees
    #[account(mut)]
    pub payer: Signer<'info>,
    
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8 + 8 + 8 + 1,  // Discriminator + 2 Pubkeys + i64 + 2 u64 + u8
        seeds = [
            b"contest",
            creator.key().as_ref(),
            contest_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub contest: Account<'info, Contest>,
    
    /// Creator's USDC token account
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = creator
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    
    /// Vault's USDC token account
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Vault authority PDA
    /// CHECK: PDA authority for vault
    #[account(
        seeds = [b"vault-authority", contest.key().as_ref()],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,
    
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleasePrize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,  // 🔐 Must be admin
    
    #[account(
        seeds = [b"global-config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    #[account(mut)]
    pub contest: Account<'info, Contest>,
    
    /// Winner's wallet
    /// CHECK: Validated by admin off-chain (from database)
    pub winner: AccountInfo<'info>,
    
    #[account(
        constraint = token_mint.key() == contest.token_mint @ ContestError::InvalidTokenMint
    )]
    pub token_mint: Account<'info, Mint>,
    
    /// Vault's USDC token account
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Winner's USDC token account
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = token_mint,
        associated_token::authority = winner
    )]
    pub winner_token_account: Account<'info, TokenAccount>,
    
    /// Vault authority PDA
    /// CHECK: PDA authority for vault
    #[account(
        seeds = [b"vault-authority", contest.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,  // 🔐 Must be admin
    
    #[account(
        seeds = [b"global-config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    #[account(mut)]
    pub contest: Account<'info, Contest>,
    
    #[account(
        constraint = token_mint.key() == contest.token_mint @ ContestError::InvalidTokenMint
    )]
    pub token_mint: Account<'info, Mint>,
    
    /// Creator's USDC token account
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = token_mint,
        associated_token::authority = creator
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    
    /// Creator's wallet
    /// CHECK: Validated by contest.creator
    #[account(
        constraint = creator.key() == contest.creator @ ContestError::Unauthorized
    )]
    pub creator: AccountInfo<'info>,
    
    /// Vault's USDC token account
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Vault authority PDA
    /// CHECK: PDA authority for vault
    #[account(
        seeds = [b"vault-authority", contest.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseContest<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,  // 🔐 Must be admin
    
    #[account(
        seeds = [b"global-config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    #[account(
        mut,
        close = admin  // Reclaim rent to admin
    )]
    pub contest: Account<'info, Contest>,
    
    #[account(
        constraint = token_mint.key() == contest.token_mint @ ContestError::InvalidTokenMint
    )]
    pub token_mint: Account<'info, Mint>,
    
    /// Vault's USDC token account
    /// Will be closed manually via SPL Token's close_account instruction
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault_authority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Vault authority PDA
    /// CHECK: PDA authority for vault, seeds verified in constraint
    #[account(
        seeds = [b"vault-authority", contest.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,  // 🔐 Current admin (must sign)
    
    #[account(
        mut,
        seeds = [b"global-config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    /// CHECK: New admin address (typically Squads Vault 0)
    /// No validation needed - admin can set to any address
    pub new_admin: AccountInfo<'info>,
}

// ==================== STATE STRUCTURES ====================

#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,  // The one and only admin (can release/refund)
    pub bump: u8,
}

#[account]
pub struct Contest {
    pub creator: Pubkey,       // Event creator (receives refunds)
    pub token_mint: Pubkey,    // USDC mint address
    pub deadline: i64,         // Contest end time (stored for reference, not enforced)
    pub total_prize_pool: u64, // Total amount deposited
    pub total_released: u64,   // Total amount released to winners (for tracking/analytics)
    pub bump: u8,              // PDA bump
}

// ==================== EVENTS ====================

#[event]
pub struct ContestCreated {
    pub contest_pda: Pubkey,
    pub creator: Pubkey,
    pub total_amount: u64,
    pub deadline: i64,
    pub timestamp: i64,
}

#[event]
pub struct PrizeReleased {
    pub contest_pda: Pubkey,
    pub winner: Pubkey,
    pub amount: u64,
    pub total_released: u64,
    pub timestamp: i64,
}

#[event]
pub struct ContestRefunded {
    pub contest_pda: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ContestClosed {
    pub contest_pda: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AdminUpdated {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
    pub timestamp: i64,
}

// ==================== ERROR CODES ====================

#[error_code]
pub enum ContestError {
    #[msg("Unauthorized: Only admin can perform this action")]
    Unauthorized,
    
    #[msg("Invalid amount: Must be greater than 0")]
    InvalidAmount,
    
    #[msg("Invalid deadline: Must be in the future")]
    InvalidDeadline,
    
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    
    #[msg("Vault not empty: Cannot close contest with remaining funds")]
    VaultNotEmpty,
    
    #[msg("Invalid new admin address")]
    InvalidNewAdmin,

    #[msg("Invalid token mint for this contest")]
    InvalidTokenMint,

    #[msg("Invalid program account (expected an upgradeable program account)")]
    InvalidProgramAccount,

    #[msg("Invalid program data account for this program")]
    InvalidProgramData,

    #[msg("Release amount would exceed total prize pool")]
    ExceedsPrizePool,
    
    #[msg("Arithmetic overflow")]
    Overflow,
}

