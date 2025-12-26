#!/usr/bin/env python3
"""
Script to import candidates from CSV to Supabase API
Processes all candidates and sends them in batches with a delay between requests
"""

import csv
import json
import requests
import time

# Configuration
CSV_FILE = "data/candidatos.csv"
API_URL = "https://wiqehffqymegcbqgggjk.supabase.co/functions/v1/import-candidates"
AGENCY_ID = "a4b6bdef-b05e-4cdc-9713-e5539bf1d7b2"
CREATED_BY = "9c3119a0-f8d9-450c-b4dd-a975f5686188"
BATCH_SIZE = 20
WAIT_TIME_MS = 600  # Wait time between requests in milliseconds

def read_candidates_from_csv(csv_path, limit=None):
    """
    Read candidates from CSV file and return list of candidate dictionaries
    
    Args:
        csv_path: Path to the CSV file
        limit: Maximum number of candidates to read (None for all)
        
    Returns:
        List of candidate dictionaries
    """
    candidates = []
    
    with open(csv_path, 'r', encoding='utf-8') as file:
        reader = csv.DictReader(file)
        
        for i, row in enumerate(reader):
            if limit is not None and i >= limit:
                break
            
            # Map CSV columns to API payload structure
            candidate = {}
            
            # Add fields only if they have values
            if row.get('Name', '').strip():
                candidate['name'] = row['Name'].strip()
            
            if row.get('URL Linkedin', '').strip():
                candidate['linkedin_url'] = row['URL Linkedin'].strip()
            
            if row.get('Last /current role', '').strip():
                candidate['role'] = row['Last /current role'].strip()
            
            if row.get('Last /current org', '').strip():
                candidate['organization'] = row['Last /current org'].strip()
            
            if row.get('Cel', '').strip():
                candidate['phone'] = row['Cel'].strip()
            
            if row.get('mail', '').strip():
                candidate['email'] = row['mail'].strip()
            
            if row.get('Location', '').strip():
                candidate['location'] = row['Location'].strip()
            
            # Only add candidate if at least name is present
            if 'name' in candidate:
                candidates.append(candidate)
            else:
                print(f"⚠ Skipped row {i+1}: No name found")
    
    return candidates

def send_batch_to_api(candidates, batch_num, total_batches, agency_id_override=None, created_by_override=None):
    """
    Send batch of candidates to the API
    
    Args:
        candidates: List of candidate dictionaries
        batch_num: Current batch number (1-indexed)
        total_batches: Total number of batches
        
    Returns:
        Tuple of (success: bool, response)
    """
    payload = {
        "agency_id": agency_id_override or AGENCY_ID,
        "created_by": created_by_override or CREATED_BY,
        "candidates": candidates
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.post(API_URL, headers=headers, json=payload)
        
        if response.status_code == 200:
            return True, response
        else:
            print(f"  ⚠ Warning: Status {response.status_code}")
            return False, response
            
    except requests.exceptions.RequestException as e:
        print(f"  ❌ Request failed: {e}")
        return False, None

def chunk_list(lst, chunk_size):
    """Split a list into chunks of specified size"""
    for i in range(0, len(lst), chunk_size):
        yield lst[i:i + chunk_size]

def main():
    """Main execution function"""
    print("=" * 70)
    print("CSV to API Import Script - Full Database Migration")
    print("=" * 70)
    print(f"\nConfiguration:")
    print(f"  - CSV File: {CSV_FILE}")
    print(f"  - Batch Size: {BATCH_SIZE} candidates")
    print(f"  - Wait Time: {WAIT_TIME_MS}ms between batches")
    print("\nReading all candidates from CSV...\n")
    
    # Read all candidates from CSV
    start_time = time.time()
    candidates = read_candidates_from_csv(CSV_FILE, limit=None)
    
    if not candidates:
        print("\n❌ No candidates found to import")
        return
    
    total_candidates = len(candidates)
    batches = list(chunk_list(candidates, BATCH_SIZE))
    total_batches = len(batches)
    
    print(f"✅ Read {total_candidates} candidates from CSV")
    print(f"📦 Split into {total_batches} batches of {BATCH_SIZE}")
    print("\n" + "=" * 70)
    print("Starting migration...\n")
    
    # Statistics
    successful_batches = 0
    failed_batches = 0
    total_sent = 0
    
    # Process each batch
    for batch_num, batch in enumerate(batches, 1):
        batch_size = len(batch)
        print(f"Batch {batch_num}/{total_batches}: Sending {batch_size} candidates...", end=" ")
        
        success, response = send_batch_to_api(batch, batch_num, total_batches)
        
        if success:
            print(f"✅ Success")
            successful_batches += 1
            total_sent += batch_size
        else:
            print(f"❌ Failed")
            failed_batches += 1
            if response:
                print(f"  Status: {response.status_code}")
                try:
                    error_data = response.json()
                    print(f"  Error: {error_data}")
                except:
                    print(f"  Response: {response.text[:200]}")
        
        # Wait between batches (except after the last one)
        if batch_num < total_batches:
            time.sleep(WAIT_TIME_MS / 1000.0)
    
    # Final summary
    elapsed_time = time.time() - start_time
    print("\n" + "=" * 70)
    print("Migration Complete!")
    print("=" * 70)
    print(f"\nStatistics:")
    print(f"  Total candidates processed: {total_candidates}")
    print(f"  Successful batches: {successful_batches}/{total_batches}")
    print(f"  Failed batches: {failed_batches}/{total_batches}")
    print(f"  Candidates sent: {total_sent}")
    print(f"  Total time: {elapsed_time:.2f} seconds")
    print(f"  Average time per batch: {elapsed_time/total_batches:.2f} seconds")
    
    if failed_batches > 0:
        print(f"\n⚠ Warning: {failed_batches} batch(es) failed. Review the logs above.")
    else:
        print(f"\n✅ All batches completed successfully!")
    
    print("=" * 70)

if __name__ == "__main__":
    main()

