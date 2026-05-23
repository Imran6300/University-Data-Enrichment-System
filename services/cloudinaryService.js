const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload an image from URL to Cloudinary
 * @param {string} imageUrl - Source image URL
 * @param {string} universitySlug - Used for folder/public_id organization
 * @param {string} type - 'logo' | 'campus' | 'classroom' | 'building'
 */
async function uploadImageFromUrl(imageUrl, universitySlug, type = "campus") {
  const folder = `universities/${universitySlug}`;

  const publicId = `${type}_${Date.now()}`;

  const result = await cloudinary.uploader.upload(imageUrl, {
    public_id: publicId,
    folder,
    resource_type: "image",
    transformation: [
      { width: 1200, height: 800, crop: "limit", quality: "auto:good" },
    ],
    tags: ["university", universitySlug, type],
  });

  return {
    url: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
  };
}

/**
 * Upload logo - smaller transformation for logos
 */
async function uploadLogo(imageUrl, universitySlug) {
  const folder = `universities/${universitySlug}/logos`;
  const publicId = `logo`;

  const result = await cloudinary.uploader.upload(imageUrl, {
    public_id: publicId,
    folder,
    resource_type: "image",
    transformation: [
      { width: 400, height: 400, crop: "limit", quality: "auto:good" },
    ],
    tags: ["university", universitySlug, "logo"],
  });

  return {
    url: result.secure_url,
    public_id: result.public_id,
  };
}

/**
 * Delete an image from Cloudinary by public_id
 */
async function deleteImage(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { uploadImageFromUrl, uploadLogo, deleteImage };
