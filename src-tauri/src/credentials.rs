// Content Credentials (C2PA) for exports: a signed record inside the file of what was done to the
// photo (the edits, and whether generative AI was used), which anyone can check, for example at
// contentcredentials.org/verify. Built on the C2PA reference library (c2pa, MIT/Apache).
//
// It is signed with a key made on this computer the first time (kept in the app's data folder) and
// a certificate from a local "Rembrandt" authority. Verifiers show the record and that the file
// hasn't changed since, but list the signer as not on their trust list: that takes a certificate
// from an authority on the C2PA trust list.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use tauri::Manager;

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("content-credentials"))
}

/// The signing certificate chain and key (PEM), made once.
fn keys(app: &tauri::AppHandle) -> Result<(Vec<u8>, Vec<u8>), String> {
    let d = dir(app)?;
    let (chain_p, key_p) = (d.join("chain.pem"), d.join("key.pem"));
    if let (Ok(c), Ok(k)) = (fs::read(&chain_p), fs::read(&key_p)) {
        return Ok((c, k));
    }
    use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256};
    let err = |e: rcgen::Error| e.to_string();
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(err)?;
    let mut ca = CertificateParams::new(Vec::<String>::new()).map_err(err)?;
    ca.distinguished_name.push(DnType::CommonName, "Rembrandt local signing authority");
    ca.distinguished_name.push(DnType::OrganizationName, "Rembrandt");
    ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    let ca_cert = ca.self_signed(&ca_key).map_err(err)?;
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(err)?;
    let mut leaf = CertificateParams::new(Vec::<String>::new()).map_err(err)?;
    leaf.distinguished_name.push(DnType::CommonName, "Rembrandt");
    leaf.distinguished_name.push(DnType::OrganizationName, "Rembrandt");
    leaf.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::EmailProtection];
    leaf.use_authority_key_identifier_extension = true;
    let leaf_cert = leaf.signed_by(&key, &Issuer::new(ca, ca_key)).map_err(err)?;
    let chain = format!("{}{}", leaf_cert.pem(), ca_cert.pem()).into_bytes();
    let pem = key.serialize_pem().into_bytes();
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    fs::write(&chain_p, &chain).map_err(|e| e.to_string())?;
    fs::write(&key_p, &pem).map_err(|e| e.to_string())?;
    Ok((chain, pem))
}

/// Signs `image` (`mime`: image/jpeg, image/png, image/webp or image/tiff) with the manifest
/// definition `manifest` (c2pa::Builder JSON); returns the signed file.
pub fn sign(app: &tauri::AppHandle, mime: &str, manifest: &str, image: &[u8]) -> Result<Vec<u8>, String> {
    let (chain, key) = keys(app)?;
    let signer = c2pa::create_signer::from_keys(&chain, &key, c2pa::SigningAlg::Es256, None).map_err(|e| e.to_string())?;
    let mut builder = c2pa::Builder::from_context(c2pa::Context::new()).with_definition(manifest).map_err(|e| e.to_string())?;
    let mut out = Cursor::new(Vec::with_capacity(image.len() + (64 << 10)));
    builder.sign(signer.as_ref(), mime, &mut Cursor::new(image), &mut out).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
